/**
 * A single upgraded WebSocket connection.
 *
 * This is the transport layer and it knows nothing about rooms, cursors or
 * presence. It owns: framing, the close handshake, liveness (ping/pong),
 * inbound rate limiting and outbound backpressure. Everything above it deals
 * in strings and typed messages.
 */

import type { Duplex } from "node:stream";
import {
  CLOSE,
  FrameDecoder,
  OPCODE,
  encodeCloseFrame,
  encodeFrame,
  encodeTextFrame,
  parseCloseFrame,
} from "./frames";

export interface ConnectionOptions {
  maxMessageBytes: number;
  /** Token bucket: sustained messages/second and burst capacity. */
  rateLimitPerSec: number;
  rateLimitBurst: number;
  /**
   * Outbound bytes queued in the kernel/stream before we start dropping
   * droppable frames. A client that cannot keep up with 20 Hz of cursor data
   * should fall behind, not accumulate an unbounded queue in the server.
   */
  highWaterMarkBytes: number;
}

export type CloseHandler = (code: number, reason: string) => void;

let nextConnectionId = 1;

export class WsConnection {
  readonly id: number = nextConnectionId++;
  readonly remoteAddress: string;

  /** Set by the layer above; receives validated-length, decoded text payloads. */
  onMessage: ((text: string) => void) | null = null;
  onClose: CloseHandler | null = null;

  /** Round-trip time from the most recent protocol-level ping/pong, in ms. */
  rtt = 0;
  bytesSent = 0;
  bytesReceived = 0;
  messagesSent = 0;
  messagesReceived = 0;
  /** Frames discarded because this socket was congested. */
  framesDropped = 0;

  private readonly decoder: FrameDecoder;
  private closed = false;
  private closeSent = false;
  private lastActivityAt = Date.now();
  private pendingPingAt = 0;
  private tokens: number;
  private lastRefillAt = Date.now();
  private closeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly socket: Duplex,
    private readonly options: ConnectionOptions,
  ) {
    this.decoder = new FrameDecoder(options.maxMessageBytes);
    this.tokens = options.rateLimitBurst;
    this.remoteAddress = (socket as { remoteAddress?: string }).remoteAddress ?? "unknown";

    // Cursor updates are tiny and latency-critical: Nagle's algorithm would
    // hold them back waiting for a full segment.
    const maybeTcp = socket as Duplex & { setNoDelay?: (on: boolean) => void };
    maybeTcp.setNoDelay?.(true);

    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("error", () => this.destroy(CLOSE.internalError, "socket error"));
    socket.on("close", () => this.destroy(CLOSE.normal, "socket closed"));
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Bytes still queued for this socket; the backpressure signal. */
  get bufferedBytes(): number {
    return (this.socket as Duplex & { writableLength?: number }).writableLength ?? 0;
  }

  get isCongested(): boolean {
    return this.bufferedBytes > this.options.highWaterMarkBytes;
  }

  /**
   * Feeds bytes that arrived before this wrapper attached -- specifically the
   * "head" buffer from the HTTP upgrade event, which holds anything the client
   * pipelined into the same TCP segment as its handshake request.
   */
  feed(chunk: Buffer): void {
    this.handleData(chunk);
  }

  private handleData(chunk: Buffer): void {
    if (this.closed) return;
    this.bytesReceived += chunk.length;
    this.lastActivityAt = Date.now();

    for (const event of this.decoder.push(chunk)) {
      if (event.kind === "error") {
        this.close(event.code, event.reason);
        return;
      }
      if (event.kind === "control") {
        this.handleControlFrame(event.opcode, event.data);
        continue;
      }
      if (event.opcode === OPCODE.binary) {
        // The protocol is JSON text; binary payloads are a client bug.
        this.close(CLOSE.unsupportedData, "binary frames not supported");
        return;
      }
      if (!this.consumeToken()) {
        this.close(CLOSE.policyViolation, "message rate limit exceeded");
        return;
      }
      this.messagesReceived++;
      this.onMessage?.(event.data.toString("utf8"));
      if (this.closed) return;
    }
  }

  private handleControlFrame(opcode: number, data: Buffer): void {
    if (opcode === OPCODE.ping) {
      this.writeFrame(encodeFrame(OPCODE.pong, data));
      return;
    }
    if (opcode === OPCODE.pong) {
      if (this.pendingPingAt !== 0) {
        this.rtt = Date.now() - this.pendingPingAt;
        this.pendingPingAt = 0;
      }
      return;
    }
    // Close: echo the code back, then let the socket wind down.
    const { code, reason } = parseCloseFrame(data);
    this.close(code === 1005 || code === 1006 ? CLOSE.normal : code, reason);
  }

  /** Token bucket, refilled continuously rather than on a timer. */
  private consumeToken(): boolean {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillAt) / 1000;
    this.lastRefillAt = now;
    this.tokens = Math.min(
      this.options.rateLimitBurst,
      this.tokens + elapsedSec * this.options.rateLimitPerSec,
    );
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Sends a JSON string. Used for control-lane messages, which are rare. */
  send(text: string): void {
    this.sendFrame(encodeTextFrame(text));
  }

  /** Sends an already-encoded frame. Shared across a room's fan-out. */
  sendFrame(frame: Buffer): void {
    if (this.closed) return;
    this.messagesSent++;
    this.writeFrame(frame);
  }

  /**
   * Sends a frame that is safe to lose -- a cursor snapshot. The next tick
   * carries newer data anyway, so on a congested socket dropping it is
   * strictly better than queueing it.
   */
  sendFrameLossy(frame: Buffer): boolean {
    if (this.closed) return false;
    if (this.isCongested) {
      this.framesDropped++;
      return false;
    }
    this.messagesSent++;
    this.writeFrame(frame);
    return true;
  }

  private writeFrame(frame: Buffer): void {
    if (this.closed || !this.socket.writable) return;
    this.bytesSent += frame.length;
    this.socket.write(frame);
  }

  /** Protocol-level ping. The payload is unused; liveness is all we want. */
  ping(): void {
    if (this.closed) return;
    if (this.pendingPingAt === 0) this.pendingPingAt = Date.now();
    this.writeFrame(encodeFrame(OPCODE.ping, Buffer.alloc(0)));
  }

  /** True when nothing has been heard from this socket for too long. */
  isStale(now: number, timeoutMs: number): boolean {
    return now - this.lastActivityAt > timeoutMs;
  }

  /** Graceful close: send a close frame, then destroy if the peer stalls. */
  close(code: number, reason = ""): void {
    if (this.closed) return;
    if (!this.closeSent && this.socket.writable) {
      this.closeSent = true;
      this.writeFrame(encodeCloseFrame(code, reason));
      this.socket.end();
      this.closeTimer = setTimeout(() => this.destroy(code, reason), 2000);
      this.closeTimer.unref?.();
      return;
    }
    this.destroy(code, reason);
  }

  private destroy(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.socket.destroy();
    this.onClose?.(code, reason);
  }
}
