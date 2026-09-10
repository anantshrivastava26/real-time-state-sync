/**
 * The server's view of the protocol.
 *
 * The definitions themselves live in shared/protocol.ts, which both packages
 * import, because a wire format defined twice is a wire format that drifts.
 * This module exists so server code imports "./protocol" (and so the file
 * layout matches the rest of the server), not to hold a second copy.
 */

export {
  PROTOCOL_VERSION,
  REACTION_KINDS,
  encode,
  fromFixed16,
  parseClientMessage,
  parseServerMessage,
  reactionKindFromIndex,
  sanitizeName,
  toFixed16,
} from "../../shared/protocol";

export type {
  ClientMessage,
  ClientMessageType,
  CursorMessage,
  CursorTuple,
  HelloMessage,
  LeaveReason,
  ParseResult,
  PeerInfo,
  PingMessage,
  ProtocolErrorCode,
  ReactionKind,
  ReactionMessage,
  ServerMessage,
  ServerMessageType,
  Slot,
  StateMessage,
} from "../../shared/protocol";
