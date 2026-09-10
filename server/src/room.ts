/**
 * Room, presence and fan-out.
 *
 * State the server actually owns:
 *   - who is in the room (identity, slot, colour, online flag)
 *   - each peer's latest cursor position and last accepted sequence number
 *
 * That is deliberately all of it. There is no history, no per-peer queue and
 * no authoritative simulation: cursors are relayed, not simulated, so memory
 * per peer is O(1) and a peer that stops moving costs nothing per tick.
 *
 * Reactions are relayed immediately (they are rare and latency-sensitive);
 * cursors are coalesced into one frame per tick (they are frequent and only
 * the newest value matters).
 */

import {
  COMBO_RADIUS,
  COMBO_WINDOW_MS,
  MAX_PEERS_PER_ROOM,
  RECONNECT_GRACE_MS,
  TICK_HZ,
} from "../../shared/config";
import { PROTOCOL_VERSION, encode, fromFixed16, toFixed16 } from "../../shared/protocol";
import type {
  CursorMessage,
  CursorTuple,
  HelloMessage,
  LeaveReason,
  PeerInfo,
  ReactionMessage,
  ServerMessage,
  Slot,
  StateMessage,
} from "../../shared/protocol";
import { encodeTextFrame } from "./ws/frames";
import type { WsConnection } from "./ws/connection";

/** Number of distinct cursor colours; the client maps the index to a palette. */
const COLOR_COUNT = 12;

/** Stable hash of a clientId into a palette index. */
function hashToColor(clientId: string): number {
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) {
    hash = (hash * 31 + clientId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % COLOR_COUNT;
}

export interface Peer {
  clientId: string;
  slot: Slot;
  name: string;
  color: number;
  /** Null while the peer is disconnected but still inside its grace window. */
  conn: WsConnection | null;
  /** Highest accepted cursor sequence number on the current connection. */
  lastSeq: number;
  x: number;
  y: number;
  /** False until the peer has sent at least one cursor sample. */
  hasPosition: boolean;
  /** Moved since the last tick, so it belongs in the next state frame. */
  dirty: boolean;
  disconnectedAt: number;
  joinedAt: number;
}

interface RecentReaction {
  id: string;
  x: number;
  y: number;
  ts: number;
  count: number;
}

export type JoinOutcome =
  | { ok: true; peer: Peer; resumed: boolean }
  | { ok: false; reason: "room-full" };

export class Room {
  private readonly peers = new Map<string, Peer>();
  private readonly bySlot = new Map<Slot, Peer>();
  private readonly recentReactions: RecentReaction[] = [];
  private tickCount = 0;
  private nextSlot = 0;

  constructor(readonly roomId: string) {}

  get size(): number {
    return this.peers.size;
  }

  get onlineCount(): number {
    let n = 0;
    for (const peer of this.peers.values()) if (peer.conn) n++;
    return n;
  }

  listPeers(): PeerInfo[] {
    return [...this.peers.values()].map(toPeerInfo);
  }

  /* ---------------------------------------------------------------- */
  /* Join / leave                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Attaches a connection to the room.
   *
   * Identity is the clientId, not the socket, which is what makes reconnects
   * non-duplicating: a returning client finds its existing Peer record and
   * keeps its slot and colour. Everyone else sees a status flip, not a
   * leave/join pair.
   */
  join(conn: WsConnection, hello: HelloMessage): JoinOutcome {
    const existing = this.peers.get(hello.clientId);
    if (existing) {
      // Same identity on a second live socket (e.g. a duplicated tab): the old
      // socket loses, because two sockets must not drive one cursor.
      const previous = existing.conn;
      existing.conn = conn;
      existing.name = hello.name;
      existing.lastSeq = 0; // Sequence numbers restart with the connection.
      existing.disconnectedAt = 0;
      if (previous && previous !== conn) {
        previous.onClose = null;
        previous.close(1000, "replaced by a newer connection");
      }
      this.broadcast({ t: "status", slot: existing.slot, online: true });
      return { ok: true, peer: existing, resumed: true };
    }

    if (this.peers.size >= MAX_PEERS_PER_ROOM) {
      return { ok: false, reason: "room-full" };
    }

    const peer: Peer = {
      clientId: hello.clientId,
      slot: this.allocateSlot(),
      name: hello.name,
      color: this.allocateColor(hello.clientId),
      conn,
      lastSeq: 0,
      x: 0.5,
      y: 0.5,
      hasPosition: false,
      dirty: false,
      disconnectedAt: 0,
      joinedAt: Date.now(),
    };
    this.peers.set(peer.clientId, peer);
    this.bySlot.set(peer.slot, peer);

    this.broadcast({ t: "join", peer: toPeerInfo(peer) }, peer.slot);
    return { ok: true, peer, resumed: false };
  }

  /** Smallest free slot, so slot numbers stay short even after churn. */
  private allocateSlot(): Slot {
    for (let i = 0; i < 0xffff; i++) {
      const candidate = (this.nextSlot + i) % 0xffff;
      if (!this.bySlot.has(candidate)) {
        this.nextSlot = (candidate + 1) % 0xffff;
        return candidate;
      }
    }
    return 0;
  }

  /**
   * Deterministic per-identity, not occupancy-order: a clientId's preferred
   * colour is a hash of itself, so the same person gets the same colour back
   * after a dropped connection or a rejoin, not just whatever slot was free.
   * Only falls back to the nearest free colour if that one is already taken
   * by someone else currently in the room.
   */
  private allocateColor(clientId: string): number {
    const used = new Set<number>();
    for (const peer of this.peers.values()) used.add(peer.color);
    const preferred = hashToColor(clientId);
    for (let i = 0; i < COLOR_COUNT; i++) {
      const candidate = (preferred + i) % COLOR_COUNT;
      if (!used.has(candidate)) return candidate;
    }
    return preferred;
  }

  /**
   * The peer's socket went away. Its slot is held for a grace window so a
   * reconnect resumes the same identity; the sweep in tick() finalizes it.
   */
  detach(peer: Peer, conn: WsConnection): void {
    if (peer.conn !== conn) return; // A newer connection already took over.
    peer.conn = null;
    peer.dirty = false;
    peer.disconnectedAt = Date.now();
    this.broadcast({ t: "status", slot: peer.slot, online: false });
  }

  /** Immediate removal: a clean bye, or the grace window expiring. */
  remove(peer: Peer, reason: LeaveReason): void {
    if (!this.peers.delete(peer.clientId)) return;
    this.bySlot.delete(peer.slot);
    peer.conn = null;
    this.broadcast({ t: "leave", slot: peer.slot, reason });
  }

  /* ---------------------------------------------------------------- */
  /* Inbound actions                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Applies a cursor sample, or drops it as stale.
   *
   * Within one WebSocket connection TCP already guarantees order, so this
   * check only fires in genuinely odd cases (a resumed connection racing the
   * old one, or a buggy client). It costs one integer compare and guarantees
   * the server never moves a cursor backwards in time.
   */
  applyCursor(peer: Peer, msg: CursorMessage): boolean {
    if (msg.q <= peer.lastSeq) return false;
    peer.lastSeq = msg.q;
    peer.x = fromFixed16(msg.x);
    peer.y = fromFixed16(msg.y);
    peer.hasPosition = true;
    peer.dirty = true;
    return true;
  }

  /**
   * Relays a reaction, merging near-simultaneous ones into a combo.
   *
   * This is the conflict-reconciliation case: two clients tapping the same
   * spot within COMBO_WINDOW_MS produce one burst carrying a count, not two
   * overlapping bursts. The server decides, so every client agrees on it.
   */
  applyReaction(peer: Peer, msg: ReactionMessage, now: number): void {
    const x = fromFixed16(msg.x);
    const y = fromFixed16(msg.y);

    this.pruneReactions(now);
    const match = this.recentReactions.find((r) => Math.hypot(r.x - x, r.y - y) <= COMBO_RADIUS);

    if (match) {
      match.count++;
      match.ts = now;
      this.broadcast({ t: "combo", id: match.id, n: match.count });
      return;
    }

    this.recentReactions.push({ id: msg.id, x, y, ts: now, count: 1 });
    this.broadcast(
      { t: "reaction", s: peer.slot, id: msg.id, x: msg.x, y: msg.y, k: msg.k, ts: now },
      // The sender already drew its own burst at tap time; echoing it back
      // would draw a second one about one RTT later.
      peer.slot,
    );
  }

  /** Bounded by time, with a count backstop against a burst of taps. */
  private pruneReactions(now: number): void {
    while (this.recentReactions.length > 0) {
      const first = this.recentReactions[0];
      if (first && now - first.ts > COMBO_WINDOW_MS) this.recentReactions.shift();
      else break;
    }
    while (this.recentReactions.length > 64) this.recentReactions.shift();
  }

  /* ---------------------------------------------------------------- */
  /* Tick                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * One tick: expire dead peers, then broadcast the cursors that moved.
   *
   * The frame is encoded exactly once and that same Buffer is written to every
   * socket, so fan-out costs O(peers) writes and O(1) serializations -- not
   * the O(peers^2) work of building a tailored message per recipient.
   */
  tick(now: number): void {
    this.sweepDisconnected(now);

    const cursors: CursorTuple[] = [];
    for (const peer of this.peers.values()) {
      if (!peer.dirty || !peer.hasPosition) continue;
      peer.dirty = false;
      cursors.push([peer.slot, toFixed16(peer.x), toFixed16(peer.y)]);
    }
    if (cursors.length === 0) return;

    this.tickCount++;
    const state: StateMessage = { t: "state", k: this.tickCount, ts: now, c: cursors };
    const frame = encodeTextFrame(encode(state));

    for (const peer of this.peers.values()) {
      // Lossy on purpose: a congested socket skips this snapshot and picks up
      // the next one 50 ms later, instead of growing a backlog of stale
      // positions it would have to chew through before showing anything live.
      peer.conn?.sendFrameLossy(frame);
    }
  }

  private sweepDisconnected(now: number): void {
    for (const peer of this.peers.values()) {
      if (!peer.conn && now - peer.disconnectedAt > RECONNECT_GRACE_MS) {
        this.remove(peer, "timeout");
      }
    }
  }

  /**
   * A snapshot of every known position, sent only to a client that just
   * joined. Without it a newcomer would not see peers who are connected but
   * holding still, because ticks only carry what changed.
   */
  fullStateFrame(now: number): Buffer | null {
    const cursors: CursorTuple[] = [];
    for (const peer of this.peers.values()) {
      if (peer.hasPosition) cursors.push([peer.slot, toFixed16(peer.x), toFixed16(peer.y)]);
    }
    if (cursors.length === 0) return null;
    this.tickCount++;
    const state: StateMessage = { t: "state", k: this.tickCount, ts: now, c: cursors };
    return encodeTextFrame(encode(state));
  }

  /* ---------------------------------------------------------------- */
  /* Fan-out                                                           */
  /* ---------------------------------------------------------------- */

  /** Control-lane broadcast: encoded once, optionally skipping one slot. */
  broadcast(message: ServerMessage, exceptSlot?: Slot): void {
    const frame = encodeTextFrame(encode(message));
    for (const peer of this.peers.values()) {
      if (exceptSlot !== undefined && peer.slot === exceptSlot) continue;
      peer.conn?.sendFrame(frame);
    }
  }

  send(peer: Peer, message: ServerMessage): void {
    peer.conn?.send(encode(message));
  }

  welcomeFor(peer: Peer, resumed: boolean, now: number): ServerMessage {
    return {
      t: "welcome",
      v: PROTOCOL_VERSION,
      roomId: this.roomId,
      slot: peer.slot,
      ts: now,
      tickHz: TICK_HZ,
      peers: this.listPeers(),
      resumed,
    };
  }
}

function toPeerInfo(peer: Peer): PeerInfo {
  return {
    clientId: peer.clientId,
    slot: peer.slot,
    name: peer.name,
    color: peer.color,
    online: peer.conn !== null,
  };
}

/**
 * Owns every room and drives them from a single timer -- one interval for the
 * whole process rather than one per room. The tick is the server's heartbeat.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private timer: NodeJS.Timeout | null = null;

  get(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const room of this.rooms.values()) {
        room.tick(now);
        if (room.size === 0) this.rooms.delete(room.roomId);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
