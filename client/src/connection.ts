import {
  APP_PING_INTERVAL_MS,
  CURSOR_MOVE_EPSILON,
  CURSOR_SEND_HZ_MAX,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_MIN_MS,
} from "../../shared/config";
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  toFixed16,
} from "../../shared/protocol";
import type {
  ClientMessage,
  PeerInfo,
  ReactionKindIndex,
  ServerMessage,
  Slot,
} from "../../shared/protocol";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting";
export interface SyncEventMap {
  message: (message: ServerMessage) => void;
  status: (status: ConnectionStatus) => void;
  error: (message: string) => void;
}

type ListenerMap = { [K in keyof SyncEventMap]: Set<SyncEventMap[K]> };

export class SyncConnection {
  private socket: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private cursorTimer: number | undefined;
  private sequence = 0;
  private lastX = -1;
  private lastY = -1;
  private pendingCursor: { x: number; y: number } | null = null;
  private readonly listeners: ListenerMap = {
    message: new Set(),
    status: new Set(),
    error: new Set(),
  };

  constructor(
    private readonly roomId: string,
    private readonly clientId: string,
    private readonly name: string,
  ) {}

  on<K extends keyof SyncEventMap>(kind: K, listener: SyncEventMap[K]): () => void {
    this.listeners[kind].add(listener);
    return () => this.listeners[kind].delete(listener);
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
    if (this.pingTimer !== undefined) window.clearInterval(this.pingTimer);
    if (this.cursorTimer !== undefined) window.clearInterval(this.cursorTimer);
    this.socket?.close(1000, "leaving room");
    this.socket = null;
  }

  sendCursor(x: number, y: number): void {
    if (Math.abs(x - this.lastX) < CURSOR_MOVE_EPSILON && Math.abs(y - this.lastY) < CURSOR_MOVE_EPSILON) return;
    this.pendingCursor = { x, y };
    this.flushCursor();
  }

  sendReaction(x: number, y: number, kind: ReactionKindIndex): void {
    this.send({
      t: "reaction",
      id: this.clientId.slice(0, 12) + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
      x: toFixed16(x),
      y: toFixed16(y),
      k: kind,
    });
  }

  private open(): void {
    if (this.closed) return;
    this.emit("status", this.retry === 0 ? "connecting" : "reconnecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const endpoint = window.location.port === "5173"
      ? protocol + "//127.0.0.1:8787/ws"
      : protocol + "//" + window.location.host + "/ws";
    this.socket = new WebSocket(endpoint);
    this.socket.addEventListener("open", () => {
      this.retry = 0;
      this.emit("status", "connected");
      this.send({ t: "hello", v: PROTOCOL_VERSION, roomId: this.roomId, clientId: this.clientId, name: this.name });
      this.pingTimer = window.setInterval(() => this.send({ t: "ping", c: Date.now() }), APP_PING_INTERVAL_MS);
      this.cursorTimer = window.setInterval(() => this.flushCursor(), 1000 / CURSOR_SEND_HZ_MAX);
    });
    this.socket.addEventListener("message", (event) => this.handleMessage(typeof event.data === "string" ? event.data : ""));
    this.socket.addEventListener("error", () => this.emit("error", "Connection error"));
    this.socket.addEventListener("close", () => {
      if (this.pingTimer !== undefined) window.clearInterval(this.pingTimer);
      if (this.cursorTimer !== undefined) window.clearInterval(this.cursorTimer);
      this.pingTimer = undefined;
      this.cursorTimer = undefined;
      if (this.closed) return;
      const wait = Math.min(RECONNECT_BACKOFF_MAX_MS, RECONNECT_BACKOFF_MIN_MS * 2 ** this.retry++);
      this.retryTimer = window.setTimeout(() => this.open(), wait);
    });
  }

  private handleMessage(raw: string): void {
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) {
      this.emit("error", "Rejected server message: " + parsed.reason);
      return;
    }
    this.emit("message", parsed.value);
  }

  private flushCursor(): void {
    if (!this.pendingCursor) return;
    const value = this.pendingCursor;
    this.pendingCursor = null;
    this.lastX = value.x;
    this.lastY = value.y;
    this.send({ t: "cursor", q: ++this.sequence, x: toFixed16(value.x), y: toFixed16(value.y) });
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private emit<K extends keyof SyncEventMap>(kind: K, value: Parameters<SyncEventMap[K]>[0]): void {
    for (const listener of this.listeners[kind]) (listener as (input: typeof value) => void)(value);
  }
}

export interface PresenceState {
  peers: Map<Slot, PeerInfo>;
  ownSlot: Slot | null;
}
