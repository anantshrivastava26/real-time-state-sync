/**
 * RFC 6455 frame codec.
 *
 * This is the whole reason the project has no "ws" dependency: everything the
 * relay needs from the WebSocket wire format is here -- header parsing,
 * unmasking, fragmentation reassembly, control frames and size limits.
 *
 * Scope, stated honestly: no permessage-deflate, no extensions, no outbound
 * fragmentation (server messages are small and always sent as a single frame),
 * and no strict UTF-8 well-formedness check on inbound text (Node decodes
 * lossily, and the JSON parse behind it rejects anything meaningful).
 */

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

/** RFC 6455 section 7.4.1 close codes used by this server. */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  policyViolation: 1008,
  messageTooBig: 1009,
  internalError: 1011,
} as const;

export type DecodeEvent =
  | { kind: "message"; opcode: typeof OPCODE.text | typeof OPCODE.binary; data: Buffer }
  | { kind: "control"; opcode: typeof OPCODE.close | typeof OPCODE.ping | typeof OPCODE.pong; data: Buffer }
  | { kind: "error"; code: number; reason: string };

const EMPTY = Buffer.alloc(0);

/**
 * Incremental decoder: TCP gives us arbitrary chunk boundaries, so frames
 * arrive split in half or several at a time. Feed every chunk to push() and
 * act on the events it returns.
 */
export class FrameDecoder {
  private pending: Buffer = EMPTY;
  private fragments: Buffer[] = [];
  private fragmentedOpcode: number | null = null;
  private fragmentedSize = 0;
  private failed = false;

  constructor(private readonly maxMessageBytes: number) {}

  push(chunk: Buffer): DecodeEvent[] {
    if (this.failed) return [];
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    const events: DecodeEvent[] = [];
    for (;;) {
      const event = this.readFrame();
      if (!event) break;
      events.push(event);
      if (event.kind === "error") {
        this.failed = true;
        this.reset();
        break;
      }
    }
    return events;
  }

  private reset(): void {
    this.pending = EMPTY;
    this.fragments = [];
    this.fragmentedOpcode = null;
    this.fragmentedSize = 0;
  }

  /** Returns null when more bytes are needed to complete the next frame. */
  private readFrame(): DecodeEvent | null {
    const buf = this.pending;
    if (buf.length < 2) return null;

    const b0 = buf[0] as number;
    const b1 = buf[1] as number;

    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;

    // We negotiate no extensions, so any reserved bit set is a protocol error.
    if (rsv !== 0) return this.protocolError("reserved bits set");

    let offset = 2;
    if (length === 126) {
      if (buf.length < offset + 2) return null;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(this.maxMessageBytes)) {
        return { kind: "error", code: CLOSE.messageTooBig, reason: "frame exceeds limit" };
      }
      length = Number(big);
      offset += 8;
    }

    if (length > this.maxMessageBytes) {
      return { kind: "error", code: CLOSE.messageTooBig, reason: "frame exceeds limit" };
    }

    // Every client-to-server frame MUST be masked (RFC 6455 section 5.1).
    if (!masked) return this.protocolError("client frame not masked");

    if (buf.length < offset + 4) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;

    if (buf.length < offset + length) return null;

    const payload = Buffer.allocUnsafe(length);
    buf.copy(payload, 0, offset, offset + length);
    for (let i = 0; i < length; i++) {
      payload[i] = (payload[i] as number) ^ (mask[i & 3] as number);
    }

    this.pending = buf.subarray(offset + length);

    const isControl = (opcode & 0x8) !== 0;
    if (isControl) {
      // Control frames may be injected between fragments, but must not be
      // fragmented themselves and are capped at 125 bytes.
      if (!fin) return this.protocolError("fragmented control frame");
      if (length > 125) return this.protocolError("control frame too long");
      if (opcode !== OPCODE.close && opcode !== OPCODE.ping && opcode !== OPCODE.pong) {
        return this.protocolError("reserved control opcode " + opcode);
      }
      return { kind: "control", opcode, data: payload };
    }

    if (opcode === OPCODE.continuation) {
      if (this.fragmentedOpcode === null) return this.protocolError("continuation without start");
      this.fragmentedSize += length;
      if (this.fragmentedSize > this.maxMessageBytes) {
        return { kind: "error", code: CLOSE.messageTooBig, reason: "message exceeds limit" };
      }
      this.fragments.push(payload);
      if (!fin) return this.readFrame();

      const data = Buffer.concat(this.fragments, this.fragmentedSize);
      const messageOpcode = this.fragmentedOpcode as typeof OPCODE.text | typeof OPCODE.binary;
      this.fragments = [];
      this.fragmentedOpcode = null;
      this.fragmentedSize = 0;
      return { kind: "message", opcode: messageOpcode, data };
    }

    if (opcode !== OPCODE.text && opcode !== OPCODE.binary) {
      return this.protocolError("reserved data opcode " + opcode);
    }
    if (this.fragmentedOpcode !== null) {
      return this.protocolError("new data frame during fragmented message");
    }

    if (fin) return { kind: "message", opcode, data: payload };

    this.fragmentedOpcode = opcode;
    this.fragments = [payload];
    this.fragmentedSize = length;
    return this.readFrame();
  }

  private protocolError(reason: string): DecodeEvent {
    return { kind: "error", code: CLOSE.protocolError, reason };
  }
}

/**
 * Encodes a single unmasked frame (server to client frames are never masked).
 *
 * Encoding is separated from sending on purpose: the room encodes one state
 * frame per tick and writes that same Buffer to every socket, so fan-out costs
 * one serialization, not one per recipient.
 */
export function encodeFrame(opcode: Opcode, payload: Buffer): Buffer {
  const length = payload.length;
  let headerSize = 2;
  if (length >= 65536) headerSize += 8;
  else if (length > 125) headerSize += 2;

  const frame = Buffer.allocUnsafe(headerSize + length);
  frame[0] = 0x80 | opcode; // FIN set: we never fragment outbound messages.

  if (length >= 65536) {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  } else if (length > 125) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = length;
  }

  payload.copy(frame, headerSize);
  return frame;
}

export function encodeTextFrame(text: string): Buffer {
  return encodeFrame(OPCODE.text, Buffer.from(text, "utf8"));
}

export function encodeCloseFrame(code: number, reason = ""): Buffer {
  const reasonBuf = Buffer.from(reason.slice(0, 120), "utf8");
  const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  return encodeFrame(OPCODE.close, payload);
}

export function parseCloseFrame(payload: Buffer): { code: number; reason: string } {
  if (payload.length < 2) return { code: CLOSE.normal, reason: "" };
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString("utf8") };
}
