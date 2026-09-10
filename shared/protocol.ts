/**
 * Wire protocol for the cursor/reaction sync engine.
 *
 * Design notes (the long version lives in ARCHITECTURE.md):
 *
 * - Encoding is JSON text frames. Binary would be ~3x smaller, but JSON keeps
 *   the protocol inspectable in devtools, and the hot path is already small
 *   because of the two decisions below.
 *
 * - Positions travel as 16-bit fixed point in a normalized [0,1] surface, not
 *   as pixels. Clients with different window sizes agree on a coordinate
 *   space, and "0.5312512" (9 bytes) becomes "34816" (5 bytes).
 *
 * - Peers are addressed on the hot path by a small integer `slot`, not by
 *   their 20+ character clientId. Slots are assigned by the server on join and
 *   announced on the control lane (`welcome`/`join`), so a per-tick state
 *   frame for 8 peers is ~120 bytes instead of ~400.
 *
 * Every message is validated on arrival by the `parse*` functions at the
 * bottom of this file. Both directions are validated: a malformed frame from
 * either side is rejected, never partially applied.
 */

import {
  MAX_CLIENT_ID_LENGTH,
  MAX_NAME_LENGTH,
  MAX_ROOM_ID_LENGTH,
} from "./config";

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** A coordinate in [0,1] quantized to 16 bits. Precision: 1/65535 of a screen. */
export type Fixed16 = number;

export const FIXED16_MAX = 65535;

export function toFixed16(normalized: number): Fixed16 {
  const clamped = normalized < 0 ? 0 : normalized > 1 ? 1 : normalized;
  return Math.round(clamped * FIXED16_MAX);
}

export function fromFixed16(fixed: Fixed16): number {
  return fixed / FIXED16_MAX;
}

/** Small integer identifying a peer on the hot path. Stable for a session. */
export type Slot = number;

/**
 * Reactions are an enum, not free text. A client cannot inject arbitrary
 * strings into everyone else's canvas, and the wire cost is one digit.
 *
 * Each kind is drawn as a vector icon (see client/src/icons.ts) so the visual
 * is identical on every platform, unlike emoji font fallbacks.
 */
export const REACTION_KINDS = ["heart", "star", "bolt", "flame", "thumb", "smile"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];
/** Index into REACTION_KINDS. One digit on the wire. */
export type ReactionKindIndex = number;

export function reactionKindFromIndex(index: ReactionKindIndex): ReactionKind {
  return REACTION_KINDS[index] ?? "heart";
}

/** Public description of a participant. Sent on the control lane only. */
export interface PeerInfo {
  /** Stable identity chosen by the client; survives reconnects. */
  clientId: string;
  slot: Slot;
  name: string;
  /** Palette index, assigned by the server so colors never collide. */
  color: number;
  /** False while a peer is in its reconnect grace window. */
  online: boolean;
}

/* ------------------------------------------------------------------ */
/* Client -> Server                                                    */
/* ------------------------------------------------------------------ */

/** First message on every connection, including reconnects. */
export interface HelloMessage {
  t: "hello";
  v: number;
  roomId: string;
  clientId: string;
  name: string;
}

/**
 * A cursor sample. `q` is a per-connection monotonic sequence number used to
 * discard stale samples (see ARCHITECTURE.md > Ordering).
 */
export interface CursorMessage {
  t: "cursor";
  q: number;
  x: Fixed16;
  y: Fixed16;
}

/** Discrete action. Bypasses tick batching and is relayed immediately. */
export interface ReactionMessage {
  t: "reaction";
  /** Client-generated id, echoed back so the sender can merge combos. */
  id: string;
  x: Fixed16;
  y: Fixed16;
  k: ReactionKindIndex;
}

/** Application-level RTT probe. `c` is echoed verbatim in the pong. */
export interface PingMessage {
  t: "ping";
  c: number;
}

/** Voluntary leave, so the server can drop the peer without a grace period. */
export interface ByeMessage {
  t: "bye";
}

export type ClientMessage =
  | HelloMessage
  | CursorMessage
  | ReactionMessage
  | PingMessage
  | ByeMessage;

export type ClientMessageType = ClientMessage["t"];

/* ------------------------------------------------------------------ */
/* Server -> Client                                                    */
/* ------------------------------------------------------------------ */

/** Full room snapshot. Answers "what does a client joining mid-session see?" */
export interface WelcomeMessage {
  t: "welcome";
  v: number;
  roomId: string;
  /** The recipient's own slot, so it can ignore itself in state frames. */
  slot: Slot;
  /** Server clock at send time; the client keeps a running offset from it. */
  ts: number;
  tickHz: number;
  peers: PeerInfo[];
  /** True when the server matched an existing peer record (reconnect). */
  resumed: boolean;
}

export interface JoinMessage {
  t: "join";
  peer: PeerInfo;
}

export interface LeaveMessage {
  t: "leave";
  slot: Slot;
  reason: LeaveReason;
}

export type LeaveReason = "bye" | "timeout" | "closed" | "error" | "replaced" | "room-full";

/** A peer's socket dropped but its slot is held during the grace window. */
export interface PeerStatusMessage {
  t: "status";
  slot: Slot;
  online: boolean;
}

/**
 * The hot path: one frame per tick per room, containing every cursor that
 * moved since the previous tick.
 *
 * Tuples, not objects: `[slot, x, y]` is 14 bytes where
 * `{"slot":3,"x":34816,"y":12000}` is 30.
 *
 * This frame is encoded once and written to every socket in the room,
 * including the peers whose own cursors it contains. Echoing a client's own
 * position back is intentional: it keeps fan-out to a single shared buffer,
 * and the client simply skips its own slot when rendering.
 */
export type CursorTuple = [slot: Slot, x: Fixed16, y: Fixed16];

export interface StateMessage {
  t: "state";
  /** Monotonic tick counter; the client discards out-of-order/duplicate ticks. */
  k: number;
  /** Server timestamp for this tick, the timebase for interpolation. */
  ts: number;
  c: CursorTuple[];
}

export interface ServerReactionMessage {
  t: "reaction";
  s: Slot;
  id: string;
  x: Fixed16;
  y: Fixed16;
  k: ReactionKindIndex;
  ts: number;
}

/** Two peers reacted at nearly the same place and time; they merged. */
export interface ComboMessage {
  t: "combo";
  /** Id of the reaction already on screen. */
  id: string;
  /** Total number of peers now part of that burst (>= 2). */
  n: number;
}

export interface PongMessage {
  t: "pong";
  c: number;
  ts: number;
}

/** Sent instead of closing, when a single message was bad but the peer is fine. */
export interface ErrorMessage {
  t: "error";
  code: ProtocolErrorCode;
  message: string;
}

export type ProtocolErrorCode =
  | "malformed"
  | "unknown-type"
  | "unexpected"
  | "version"
  | "room-full"
  | "rate-limit"
  | "too-large";

export type ServerMessage =
  | WelcomeMessage
  | JoinMessage
  | LeaveMessage
  | PeerStatusMessage
  | StateMessage
  | ServerReactionMessage
  | ComboMessage
  | PongMessage
  | ErrorMessage;

export type ServerMessageType = ServerMessage["t"];

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ProtocolErrorCode; reason: string };

function fail<T>(code: ProtocolErrorCode, reason: string): ParseResult<T> {
  return { ok: false, code, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects NaN/Infinity/non-integers as well as out-of-range values. */
function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isFixed16(value: unknown): value is Fixed16 {
  return isInt(value, 0, FIXED16_MAX);
}

function isStr(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isBool(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Names are shown to other users, so they are sanitized on arrival rather than
 * at render time: control characters (which would corrupt canvas labels) are
 * replaced, whitespace is collapsed, and length is capped.
 */
export function sanitizeName(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) || "Guest";
}

function parseJson(raw: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return fail("malformed", "not valid JSON");
  }
}

/**
 * Validates an inbound client frame. Returns a typed message or a reason --
 * never throws, and never returns a partially-checked object.
 */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  const json = parseJson(raw);
  if (!json.ok) return json;
  const m = json.value;
  if (!isRecord(m)) return fail("malformed", "message must be an object");

  switch (m["t"]) {
    case "hello": {
      if (!isInt(m["v"], 0, 1000)) return fail("malformed", "hello.v must be an integer");
      if (m["v"] !== PROTOCOL_VERSION) {
        return fail("version", "protocol v" + String(m["v"]) + " != v" + PROTOCOL_VERSION);
      }
      if (!isStr(m["roomId"], MAX_ROOM_ID_LENGTH)) return fail("malformed", "hello.roomId invalid");
      if (!isStr(m["clientId"], MAX_CLIENT_ID_LENGTH)) return fail("malformed", "hello.clientId invalid");
      if (typeof m["name"] !== "string") return fail("malformed", "hello.name invalid");
      return {
        ok: true,
        value: {
          t: "hello",
          v: PROTOCOL_VERSION,
          roomId: m["roomId"],
          clientId: m["clientId"],
          name: sanitizeName(m["name"]),
        },
      };
    }
    case "cursor": {
      if (!isInt(m["q"], 0, Number.MAX_SAFE_INTEGER)) return fail("malformed", "cursor.q invalid");
      if (!isFixed16(m["x"]) || !isFixed16(m["y"])) return fail("malformed", "cursor.x/y invalid");
      return { ok: true, value: { t: "cursor", q: m["q"], x: m["x"], y: m["y"] } };
    }
    case "reaction": {
      if (!isStr(m["id"], 40)) return fail("malformed", "reaction.id invalid");
      if (!isFixed16(m["x"]) || !isFixed16(m["y"])) return fail("malformed", "reaction.x/y invalid");
      if (!isInt(m["k"], 0, REACTION_KINDS.length - 1)) return fail("malformed", "reaction.k invalid");
      return { ok: true, value: { t: "reaction", id: m["id"], x: m["x"], y: m["y"], k: m["k"] } };
    }
    case "ping": {
      if (!isInt(m["c"], 0, Number.MAX_SAFE_INTEGER)) return fail("malformed", "ping.c invalid");
      return { ok: true, value: { t: "ping", c: m["c"] } };
    }
    case "bye":
      return { ok: true, value: { t: "bye" } };
    default:
      return fail("unknown-type", "unknown message type " + JSON.stringify(m["t"]));
  }
}

function parsePeerInfo(value: unknown): PeerInfo | null {
  if (!isRecord(value)) return null;
  if (!isStr(value["clientId"], MAX_CLIENT_ID_LENGTH)) return null;
  if (!isInt(value["slot"], 0, 0xffff)) return null;
  if (typeof value["name"] !== "string") return null;
  if (!isInt(value["color"], 0, 255)) return null;
  if (!isBool(value["online"])) return null;
  return {
    clientId: value["clientId"],
    slot: value["slot"],
    name: sanitizeName(value["name"]),
    color: value["color"],
    online: value["online"],
  };
}

const LEAVE_REASONS: readonly string[] = ["bye", "timeout", "closed", "error", "replaced", "room-full"];

/**
 * Validates an inbound server frame.
 *
 * The client validates too: a buggy or hostile server should not be able to
 * crash the render loop with a missing field, and an unknown message type must
 * be safely ignorable so the server can be upgraded ahead of clients.
 */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  const json = parseJson(raw);
  if (!json.ok) return json;
  const m = json.value;
  if (!isRecord(m)) return fail("malformed", "message must be an object");

  switch (m["t"]) {
    case "welcome": {
      if (!isInt(m["v"], 0, 1000) || m["v"] !== PROTOCOL_VERSION) return fail("version", "welcome.v mismatch");
      if (!isStr(m["roomId"], MAX_ROOM_ID_LENGTH)) return fail("malformed", "welcome.roomId invalid");
      if (!isInt(m["slot"], 0, 0xffff)) return fail("malformed", "welcome.slot invalid");
      if (typeof m["ts"] !== "number" || !Number.isFinite(m["ts"])) return fail("malformed", "welcome.ts invalid");
      if (!isInt(m["tickHz"], 1, 240)) return fail("malformed", "welcome.tickHz invalid");
      if (!Array.isArray(m["peers"])) return fail("malformed", "welcome.peers invalid");
      const peers: PeerInfo[] = [];
      for (const entry of m["peers"]) {
        const peer = parsePeerInfo(entry);
        if (!peer) return fail("malformed", "welcome.peers[] invalid");
        peers.push(peer);
      }
      return {
        ok: true,
        value: {
          t: "welcome",
          v: PROTOCOL_VERSION,
          roomId: m["roomId"],
          slot: m["slot"],
          ts: m["ts"],
          tickHz: m["tickHz"],
          peers,
          resumed: m["resumed"] === true,
        },
      };
    }
    case "join": {
      const peer = parsePeerInfo(m["peer"]);
      if (!peer) return fail("malformed", "join.peer invalid");
      return { ok: true, value: { t: "join", peer } };
    }
    case "leave": {
      if (!isInt(m["slot"], 0, 0xffff)) return fail("malformed", "leave.slot invalid");
      const reason = m["reason"];
      if (typeof reason !== "string" || !LEAVE_REASONS.includes(reason)) {
        return fail("malformed", "leave.reason invalid");
      }
      return { ok: true, value: { t: "leave", slot: m["slot"], reason: reason as LeaveReason } };
    }
    case "status": {
      if (!isInt(m["slot"], 0, 0xffff)) return fail("malformed", "status.slot invalid");
      if (!isBool(m["online"])) return fail("malformed", "status.online invalid");
      return { ok: true, value: { t: "status", slot: m["slot"], online: m["online"] } };
    }
    case "state": {
      if (!isInt(m["k"], 0, Number.MAX_SAFE_INTEGER)) return fail("malformed", "state.k invalid");
      if (typeof m["ts"] !== "number" || !Number.isFinite(m["ts"])) return fail("malformed", "state.ts invalid");
      if (!Array.isArray(m["c"])) return fail("malformed", "state.c invalid");
      const cursors: CursorTuple[] = [];
      for (const entry of m["c"] as unknown[]) {
        if (!Array.isArray(entry) || entry.length !== 3) return fail("malformed", "state.c[] shape");
        const [slot, x, y] = entry as unknown[];
        if (!isInt(slot, 0, 0xffff) || !isFixed16(x) || !isFixed16(y)) {
          return fail("malformed", "state.c[] values");
        }
        cursors.push([slot, x, y]);
      }
      return { ok: true, value: { t: "state", k: m["k"], ts: m["ts"], c: cursors } };
    }
    case "reaction": {
      if (!isInt(m["s"], 0, 0xffff)) return fail("malformed", "reaction.s invalid");
      if (!isStr(m["id"], 40)) return fail("malformed", "reaction.id invalid");
      if (!isFixed16(m["x"]) || !isFixed16(m["y"])) return fail("malformed", "reaction.x/y invalid");
      if (!isInt(m["k"], 0, REACTION_KINDS.length - 1)) return fail("malformed", "reaction.k invalid");
      if (typeof m["ts"] !== "number" || !Number.isFinite(m["ts"])) return fail("malformed", "reaction.ts invalid");
      return {
        ok: true,
        value: { t: "reaction", s: m["s"], id: m["id"], x: m["x"], y: m["y"], k: m["k"], ts: m["ts"] },
      };
    }
    case "combo": {
      if (!isStr(m["id"], 40)) return fail("malformed", "combo.id invalid");
      if (!isInt(m["n"], 2, 0xffff)) return fail("malformed", "combo.n invalid");
      return { ok: true, value: { t: "combo", id: m["id"], n: m["n"] } };
    }
    case "pong": {
      if (!isInt(m["c"], 0, Number.MAX_SAFE_INTEGER)) return fail("malformed", "pong.c invalid");
      if (typeof m["ts"] !== "number" || !Number.isFinite(m["ts"])) return fail("malformed", "pong.ts invalid");
      return { ok: true, value: { t: "pong", c: m["c"], ts: m["ts"] } };
    }
    case "error": {
      if (typeof m["code"] !== "string") return fail("malformed", "error.code invalid");
      return {
        ok: true,
        value: {
          t: "error",
          code: m["code"] as ProtocolErrorCode,
          message: typeof m["message"] === "string" ? m["message"].slice(0, 200) : "",
        },
      };
    }
    default:
      return fail("unknown-type", "unknown message type " + JSON.stringify(m["t"]));
  }
}

export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}
