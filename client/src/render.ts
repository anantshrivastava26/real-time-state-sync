import { fromFixed16, reactionKindFromIndex } from "../../shared/protocol";
import type { PeerInfo, ServerMessage, Slot } from "../../shared/protocol";
import { RemoteCursor, RenderClock } from "./interpolation";
import { reactionIcons } from "./icons";

export interface Burst { id: string; x: number; y: number; kind: string; born: number; count: number; color: string; }
export const colors = ["#ff6b5e", "#ffbd59", "#6dd6a4", "#5dc8ff", "#b58cff", "#f184c5", "#e6e96b", "#79a7ff", "#ff936e", "#6ce0d0", "#d9a4ff", "#a9d36e"];

const BURST_MS = 1500;
const LABEL_FONT = "600 11px 'Space Grotesk', ui-sans-serif, system-ui";
const HUD_FONT = "10px 'DM Mono', ui-monospace, monospace";
const CURSOR_PATH = "M0 0 L0 22 L7 17 L12 28 L16 26 L11 15 L20 15 Z";

export function colorForPeer(peer: PeerInfo): string {
  return colors[peer.color % colors.length] as string;
}

/** Rounded rectangle that falls back to a plain path where ctx.roundRect is missing. */
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

export class SyncRenderer {
  private readonly cursors = new Map<Slot, RemoteCursor>();
  private readonly bursts = new Map<string, Burst>();
  private readonly clock = new RenderClock();
  private readonly cursorPath = new Path2D(CURSOR_PATH);
  private readonly iconPaths = new Map<string, Path2D>();
  private peers = new Map<Slot, PeerInfo>();
  private ownSlot: Slot | null = null;
  private frame = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Cancels the render loop. Without this, a replaced renderer keeps clearing the shared canvas. */
  stop(): void { if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; } }

  setPresence(peers: PeerInfo[], ownSlot: Slot): void { this.peers = new Map(peers.map((peer) => [peer.slot, peer])); this.ownSlot = ownSlot; }
  upsertPeer(peer: PeerInfo): void { this.peers.set(peer.slot, peer); }
  setPeerOnline(slot: Slot, online: boolean): void { const peer = this.peers.get(slot); if (peer) this.peers.set(slot, { ...peer, online }); }
  remove(slot: Slot): void { this.cursors.delete(slot); this.peers.delete(slot); }

  handle(message: ServerMessage): void {
    if (message.t === "state") {
      const arrival = Date.now();
      this.clock.observe(message.ts, arrival);
      for (const [slot, x, y] of message.c) {
        if (slot === this.ownSlot) continue;
        let cursor = this.cursors.get(slot);
        if (!cursor) { cursor = new RemoteCursor(); this.cursors.set(slot, cursor); }
        cursor.push({ at: message.ts, x: fromFixed16(x), y: fromFixed16(y) });
      }
    } else if (message.t === "reaction") {
      const peer = this.peers.get(message.s);
      this.addBurst(message.id, fromFixed16(message.x), fromFixed16(message.y), reactionKindFromIndex(message.k), peer ? colorForPeer(peer) : colors[0] as string);
    } else if (message.t === "combo") {
      const burst = this.bursts.get(message.id); if (burst) burst.count = message.n;
    }
  }

  addLocalBurst(id: string, x: number, y: number, kind: string, color: string): void { this.addBurst(id, x, y, kind, color); }

  private addBurst(id: string, x: number, y: number, kind: string, color: string): void {
    this.bursts.set(id, { id, x, y, kind, born: performance.now(), count: 1, color });
  }

  /** Cached Path2D per reaction kind; a bad path falls back to a filled dot. */
  private iconPath(kind: string): Path2D | null {
    const cached = this.iconPaths.get(kind); if (cached) return cached;
    const source = reactionIcons[kind] ?? reactionIcons.heart; if (!source) return null;
    try { const path = new Path2D(source); this.iconPaths.set(kind, path); return path; } catch { return null; }
  }

  private drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, peer: PeerInfo, color: string): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = peer.online ? 1 : 0.4;

    ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
    ctx.fillStyle = color; ctx.fill(this.cursorPath);
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = "rgba(10,14,16,.65)"; ctx.lineWidth = 1.25; ctx.lineJoin = "round"; ctx.stroke(this.cursorPath);

    ctx.font = LABEL_FONT;
    const label = peer.name;
    const width = ctx.measureText(label).width;
    ctx.shadowColor = "rgba(0,0,0,.4)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
    ctx.fillStyle = color;
    roundedRect(ctx, 19, 15, width + 18, 21, 7);
    ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.fillStyle = "rgba(10,14,16,.92)";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 28, 26);
    ctx.restore();
  }

  private drawBurst(ctx: CanvasRenderingContext2D, burst: Burst, progress: number, width: number, height: number): void {
    const eased = easeOut(progress);
    const x = burst.x * width;
    const y = burst.y * height - eased * 14;
    const fade = 1 - progress * progress;

    ctx.save();
    ctx.translate(x, y);

    ctx.globalAlpha = fade * 0.85;
    ctx.strokeStyle = burst.color;
    ctx.lineWidth = 2 - eased * 1.4;
    ctx.beginPath(); ctx.arc(0, 0, 16 + eased * 34, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = fade * 0.28;
    ctx.beginPath(); ctx.arc(0, 0, 8 + eased * 18, 0, Math.PI * 2); ctx.stroke();

    ctx.globalAlpha = fade;
    ctx.fillStyle = burst.color;
    ctx.shadowColor = burst.color; ctx.shadowBlur = 18;
    const scale = 1.1 + eased * 0.5;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(-12, -12);
    const icon = this.iconPath(burst.kind);
    if (icon) ctx.fill(icon);
    else { ctx.beginPath(); ctx.arc(12, 12, 8, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    ctx.shadowBlur = 0;

    if (burst.count > 1) {
      const label = "x" + burst.count;
      ctx.font = LABEL_FONT;
      const width2 = ctx.measureText(label).width;
      ctx.fillStyle = burst.color;
      roundedRect(ctx, 20, -32, width2 + 14, 19, 9);
      ctx.fill();
      ctx.fillStyle = "rgba(10,14,16,.92)";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 27, -22);
    }
    ctx.restore();
  }

  draw(now: number): void {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth; const height = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) { this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr); }
    const ctx = this.canvas.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);

    for (const [slot, cursor] of this.cursors) {
      const position = cursor.sample(this.clock.renderAt); const peer = this.peers.get(slot);
      if (!position || !peer) continue;
      this.drawCursor(ctx, position.x * width, position.y * height, peer, colorForPeer(peer));
    }

    for (const [id, burst] of this.bursts) {
      const age = now - burst.born;
      if (age > BURST_MS) { this.bursts.delete(id); continue; }
      this.drawBurst(ctx, burst, age / BURST_MS, width, height);
    }

    ctx.font = HUD_FONT; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(244,241,234,.3)";
    ctx.fillText("RENDER DELAY " + this.clock.delay + "MS", 18, 24);

    this.frame = requestAnimationFrame((frameNow) => this.draw(frameNow));
  }
}
