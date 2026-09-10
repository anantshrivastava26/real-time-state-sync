/**
 * HTTP server, WebSocket upgrade, and the per-connection session state machine.
 *
 * Layering, from the bottom up:
 *   ws/frames.ts      RFC 6455 bytes
 *   ws/connection.ts  one socket: framing, liveness, backpressure
 *   protocol.ts       message shapes and validation (shared with the client)
 *   room.ts           presence, relay, tick
 *   server.ts         wiring, and only wiring
 *
 * Adding a new action type means touching protocol.ts and room.ts. Nothing
 * below those two files knows what a cursor is.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";

import {
  INBOUND_RATE_LIMIT_BURST,
  INBOUND_RATE_LIMIT_PER_SEC,
  MAX_MESSAGE_BYTES,
  TICK_MS,
  WS_LIVENESS_TIMEOUT_MS,
  WS_PING_INTERVAL_MS,
} from "../../shared/config";
import { encode, parseClientMessage } from "./protocol";
import type { Peer, Room } from "./room";
import { RoomRegistry } from "./room";
import { WsConnection } from "./ws/connection";
import { CLOSE } from "./ws/frames";
import { acceptUpgrade, rejectUpgrade, validateUpgrade } from "./ws/handshake";

const PORT = Number(process.env["PORT"] ?? 8787);
const HOST = process.env["HOST"] ?? "0.0.0.0";

/** A client that keeps sending garbage is disconnected rather than served. */
const MAX_MALFORMED_MESSAGES = 5;

const registry = new RoomRegistry();
registry.start(TICK_MS);

/**
 * Per-connection state. A connection is anonymous until it sends hello; only
 * then does it get a Peer in a Room.
 */
interface Session {
  conn: WsConnection;
  room: Room | null;
  peer: Peer | null;
  malformed: number;
}

const sessions = new Map<number, Session>();

/* ------------------------------------------------------------------ */
/* Static file serving (so a production build is a single process)     */
/* ------------------------------------------------------------------ */

const here = fileURLToPath(new URL(".", import.meta.url));
const CLIENT_DIST = resolve(here, "../../client/dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = (req.url ?? "/").split("?")[0] ?? "/";

  if (urlPath === "/health") {
    const body = {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      connections: sessions.size,
      rooms: registry.list().map((room) => ({
        roomId: room.roomId,
        peers: room.size,
        online: room.onlineCount,
      })),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Resolve inside CLIENT_DIST only: normalize first, then verify the prefix,
  // so "/../server/src/server.ts" cannot escape the served directory.
  const relative = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(CLIENT_DIST, relative);
  if (!filePath.startsWith(CLIENT_DIST)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath).catch(() => null);
    if (!info || info.isDirectory()) filePath = join(CLIENT_DIST, "index.html");
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(
      "Client build not found. Run the dev server (npm run dev) or build it (npm run build).\n",
    );
  }
}

const httpServer = createServer((req, res) => {
  void serveStatic(req, res);
});

/* ------------------------------------------------------------------ */
/* Upgrade                                                             */
/* ------------------------------------------------------------------ */

httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const result = validateUpgrade(req);
  if (!result.ok) {
    log("upgrade rejected: " + result.status + " " + result.message);
    rejectUpgrade(socket, result.status, result.message);
    return;
  }
  acceptUpgrade(socket, result.acceptKey);

  const conn = new WsConnection(socket, {
    maxMessageBytes: MAX_MESSAGE_BYTES,
    rateLimitPerSec: INBOUND_RATE_LIMIT_PER_SEC,
    rateLimitBurst: INBOUND_RATE_LIMIT_BURST,
    highWaterMarkBytes: 256 * 1024,
  });

  const session: Session = { conn, room: null, peer: null, malformed: 0 };
  sessions.set(conn.id, session);

  conn.onMessage = (text) => handleMessage(session, text);
  conn.onClose = () => handleClose(session);

  // Bytes that arrived in the same TCP segment as the upgrade request.
  if (head.length > 0) conn.feed(head);
});

/* ------------------------------------------------------------------ */
/* Session state machine                                               */
/* ------------------------------------------------------------------ */

function handleMessage(session: Session, text: string): void {
  const parsed = parseClientMessage(text);

  if (!parsed.ok) {
    // A malformed message is rejected, never partially applied. The connection
    // survives a few of them (clients get upgraded mid-session) but not a flood.
    session.conn.send(encode({ t: "error", code: parsed.code, message: parsed.reason }));
    if (++session.malformed >= MAX_MALFORMED_MESSAGES) {
      session.conn.close(CLOSE.policyViolation, "too many malformed messages");
    }
    return;
  }

  const msg = parsed.value;
  const now = Date.now();

  if (msg.t === "hello") {
    if (session.peer) {
      session.conn.send(encode({ t: "error", code: "unexpected", message: "already joined" }));
      return;
    }
    const room = registry.get(msg.roomId);
    const outcome = room.join(session.conn, msg);
    if (!outcome.ok) {
      session.conn.send(encode({ t: "error", code: "room-full", message: "room is full" }));
      session.conn.close(CLOSE.policyViolation, "room is full");
      return;
    }

    session.room = room;
    session.peer = outcome.peer;
    room.send(outcome.peer, room.welcomeFor(outcome.peer, outcome.resumed, now));

    // Cursors of peers who are connected but not currently moving would not
    // appear in any delta tick, so the newcomer gets one full snapshot.
    const snapshot = room.fullStateFrame(now);
    if (snapshot) session.conn.sendFrame(snapshot);

    log(
      (outcome.resumed ? "resume" : "join  ") +
        " room=" + room.roomId +
        " slot=" + outcome.peer.slot +
        " name=" + JSON.stringify(outcome.peer.name) +
        " peers=" + room.size,
    );
    return;
  }

  // Everything else requires a joined session.
  const { room, peer } = session;
  if (!room || !peer) {
    session.conn.send(encode({ t: "error", code: "unexpected", message: "hello required first" }));
    session.conn.close(CLOSE.policyViolation, "hello required first");
    return;
  }

  switch (msg.t) {
    case "cursor":
      room.applyCursor(peer, msg);
      return;
    case "reaction":
      room.applyReaction(peer, msg, now);
      return;
    case "ping":
      // Echoed immediately, off the tick, so the RTT measured is the network's
      // and not the tick phase.
      room.send(peer, { t: "pong", c: msg.c, ts: now });
      return;
    case "bye":
      room.remove(peer, "bye");
      session.peer = null;
      session.room = null;
      session.conn.close(CLOSE.normal, "bye");
      log("bye   room=" + room.roomId + " slot=" + peer.slot + " peers=" + room.size);
      return;
  }
}

function handleClose(session: Session): void {
  sessions.delete(session.conn.id);
  const { room, peer } = session;
  if (!room || !peer) return;
  // Not a removal: the slot is held through the grace window so a reconnect
  // resumes the same identity. The room sweep finalizes it if nobody returns.
  room.detach(peer, session.conn);
  log("drop  room=" + room.roomId + " slot=" + peer.slot + " (grace window started)");
}

/* ------------------------------------------------------------------ */
/* Liveness                                                            */
/* ------------------------------------------------------------------ */

/**
 * A dropped connection (laptop lid, lost wifi) produces no close event, so the
 * only reliable detector is silence. Every peer is pinged on an interval and
 * anything that has not spoken within the timeout is closed, which then runs
 * the normal disconnect path.
 */
const livenessTimer = setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.conn.isStale(now, WS_LIVENESS_TIMEOUT_MS)) {
      log("stale connection " + session.conn.id + ", closing");
      session.conn.close(CLOSE.goingAway, "liveness timeout");
      continue;
    }
    session.conn.ping();
  }
}, WS_PING_INTERVAL_MS);

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function log(line: string): void {
  process.stdout.write(new Date().toISOString() + " " + line + "\n");
}

httpServer.listen(PORT, HOST, () => {
  log("sync server listening on http://" + HOST + ":" + PORT);
  log("websocket endpoint ws://" + HOST + ":" + PORT + "/ws");
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("received " + signal + ", shutting down");
  clearInterval(livenessTimer);
  registry.stop();
  // 1001 "going away" tells clients this was intentional; they reconnect with
  // backoff and resume their identity when the server comes back.
  for (const session of sessions.values()) session.conn.close(CLOSE.goingAway, "server shutting down");
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
