/**
 * RFC 6455 opening handshake.
 *
 * The upgrade is a plain HTTP request; the only interesting part is proving to
 * the client that we actually speak WebSocket by hashing its nonce with the
 * protocol GUID. Anything that is not a well-formed v13 upgrade gets a plain
 * HTTP error, not a half-open socket.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F";

export function computeAcceptKey(secWebSocketKey: string): string {
  return createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

export type HandshakeResult =
  | { ok: true; acceptKey: string }
  | { ok: false; status: number; message: string };

export function validateUpgrade(req: IncomingMessage): HandshakeResult {
  if (req.method !== "GET") {
    return { ok: false, status: 405, message: "Method Not Allowed" };
  }
  const upgrade = req.headers["upgrade"];
  if (typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
    return { ok: false, status: 400, message: "Expected Upgrade: websocket" };
  }
  const version = req.headers["sec-websocket-version"];
  if (version !== "13") {
    return { ok: false, status: 426, message: "Unsupported WebSocket version" };
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) {
    return { ok: false, status: 400, message: "Invalid Sec-WebSocket-Key" };
  }
  return { ok: true, acceptKey: computeAcceptKey(key) };
}

export function acceptUpgrade(socket: Duplex, acceptKey: string): void {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + acceptKey + "\r\n" +
      "\r\n",
  );
}

export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = message + "\n";
  socket.write(
    "HTTP/1.1 " + status + " " + message + "\r\n" +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      "Content-Length: " + Buffer.byteLength(body) + "\r\n" +
      "\r\n" +
      body,
  );
  socket.destroy();
}
