import { fromFixed16, reactionKindFromIndex } from "../../shared/protocol";
import type { PeerInfo, ServerMessage, Slot } from "../../shared/protocol";
import { RemoteCursor, RenderClock } from "./interpolation";
import { reactionIcons } from "./icons";

export interface Burst { id: string; x: number; y: number; kind: string; born: number; count: number; color: string; }
const colors = ["#ff6b5e", "#ffbd59", "#6dd6a4", "#5dc8ff", "#b58cff", "#f184c5", "#e6e96b", "#79a7ff", "#ff936e", "#6ce0d0", "#d9a4ff", "#a9d36e"];

export class SyncRenderer {
  private readonly cursors = new Map<Slot, RemoteCursor>();
  private readonly bursts = new Map<string, Burst>();
  private readonly clock = new RenderClock();
  private peers = new Map<Slot, PeerInfo>();
  private ownSlot: Slot | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  setPresence(peers: PeerInfo[], ownSlot: Slot): void { this.peers = new Map(peers.map((peer) => [peer.slot, peer])); this.ownSlot = ownSlot; }
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
      this.addBurst(message.id, fromFixed16(message.x), fromFixed16(message.y), reactionKindFromIndex(message.k), peer ? colors[peer.color % colors.length] as string : colors[0] as string);
    } else if (message.t === "combo") {
      const burst = this.bursts.get(message.id); if (burst) burst.count = message.n;
    }
  }

  addLocalBurst(id: string, x: number, y: number, kind: string, color: string): void { this.addBurst(id, x, y, kind, color); }

  private addBurst(id: string, x: number, y: number, kind: string, color: string): void {
    this.bursts.set(id, { id, x, y, kind, born: performance.now(), count: 1, color });
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
      const x = position.x * width; const y = position.y * height; const color = colors[peer.color % colors.length] as string;
      ctx.save(); ctx.translate(x, y); ctx.shadowColor = color; ctx.shadowBlur = 16; ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 22); ctx.lineTo(7, 17); ctx.lineTo(12, 28); ctx.lineTo(16, 26); ctx.lineTo(11, 15); ctx.lineTo(20, 15); ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0; ctx.font = "600 12px ui-sans-serif"; ctx.fillStyle = "#f4f1ea"; ctx.fillText(peer.name, 24, 14); ctx.restore();
    }
    for (const [id, burst] of this.bursts) {
      const age = now - burst.born; if (age > 1500) { this.bursts.delete(id); continue; }
      const progress = age / 1500; const scale = 1 + progress * 0.7; const alpha = 1 - progress;
      ctx.save(); ctx.translate(burst.x * width, burst.y * height); ctx.scale(scale, scale); ctx.globalAlpha = alpha; ctx.strokeStyle = burst.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 22 + progress * 22, 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = burst.color; ctx.translate(-12, -12); ctx.scale(1.1, 1.1);
      try {
        ctx.fill(new Path2D(reactionIcons[burst.kind] ?? reactionIcons.heart));
      } catch {
        ctx.beginPath(); ctx.arc(12, 12, 8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      if (burst.count > 1) { ctx.fillStyle = "#f4f1ea"; ctx.font = "700 12px ui-sans-serif"; ctx.fillText("x" + burst.count, burst.x * width + 22, burst.y * height - 20); }
    }
    ctx.fillStyle = "rgba(244, 241, 234, .42)"; ctx.font = "11px ui-sans-serif"; ctx.fillText("render delay " + this.clock.delay + "ms", 18, height - 18);
    requestAnimationFrame((frameNow) => this.draw(frameNow));
  }
}
