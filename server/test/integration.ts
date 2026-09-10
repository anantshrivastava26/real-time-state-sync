import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = 9000 + (process.pid % 900);
const room = "integration-" + Date.now();
const server = spawn(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), "src/server.ts"], { cwd: resolve(root, "server"), env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
server.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });

interface Message { t: string; [key: string]: unknown; }
class TestClient {
  readonly socket: Socket = connect(port, "localhost");
  readonly messages: Message[] = [];
  private readonly waiters: Array<(message: Message) => void> = [];
  private buffer = Buffer.alloc(0);
  private opened = false;
  constructor(readonly id: string, readonly name: string) {
    this.socket.on("data", (chunk) => this.receive(chunk));
  }
  async open(): Promise<void> { await new Promise<void>((resolveOpen, reject) => { this.socket.once("error", () => reject(new Error("socket error; server output: " + serverOutput))); this.socket.once("connect", () => { this.socket.write("GET /ws HTTP/1.1\r\nHost: localhost:" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + randomBytes(16).toString("base64") + "\r\n\r\n"); }); const check = () => { if (this.opened) resolveOpen(); else setTimeout(check, 1); }; check(); }); }
  send(value: object): void { const payload = Buffer.from(JSON.stringify(value)); const mask = randomBytes(4); const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]); const masked = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) masked[i] = (payload[i] as number) ^ (mask[i % 4] as number); this.socket.write(Buffer.concat([header, mask, masked])); }
  async next(type: string): Promise<Message> { const existing = this.messages.find((message) => message.t === type); if (existing) return existing; return new Promise((resolveMessage) => this.waiters.push((message) => { if (message.t === type) resolveMessage(message); else void this.next(type).then(resolveMessage); })); }
  close(): void { this.socket.end(); }
  private receive(chunk: Buffer): void { this.buffer = Buffer.concat([this.buffer, chunk]); if (!this.opened) { const headerEnd = this.buffer.indexOf("\r\n\r\n"); if (headerEnd < 0) return; this.opened = this.buffer.subarray(0, headerEnd).toString().includes("101 Switching Protocols"); this.buffer = this.buffer.subarray(headerEnd + 4); } while (this.buffer.length >= 2) { const length = (this.buffer[1] as number) & 0x7f; const headerLength = length < 126 ? 2 : 4; const payloadLength = length < 126 ? length : this.buffer.readUInt16BE(2); if (this.buffer.length < headerLength + payloadLength) return; const opcode = (this.buffer[0] as number) & 0x0f; const payload = this.buffer.subarray(headerLength, headerLength + payloadLength); this.buffer = this.buffer.subarray(headerLength + payloadLength); if (opcode !== 1) continue; const message = JSON.parse(payload.toString()) as Message; this.messages.push(message); this.waiters.splice(0).forEach((resolveMessage) => resolveMessage(message)); } }
}

async function main(): Promise<void> {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/health");
      if (response.ok) { ready = true; break; }
    } catch {}
    await wait(50);
  }
  assert.equal(ready, true, "server did not become ready: " + serverOutput);
  const first = new TestClient("client-a", "Alpha"); const second = new TestClient("client-b", "Bravo");
  await Promise.all([first.open(), second.open()]);
  const hello = { t: "hello", v: 1, roomId: room, clientId: first.id, name: first.name };
  first.send(hello); second.send({ ...hello, clientId: second.id, name: second.name });
  const [welcome, secondWelcome] = await Promise.all([first.next("welcome"), second.next("welcome")]);
  assert.equal(welcome.t, "welcome"); assert.equal(secondWelcome.t, "welcome");
  const firstSlot = Number(welcome.slot); const secondSlot = Number(secondWelcome.slot);
  first.send({ t: "cursor", q: 1, x: 42000, y: 21000 });
  const state = await second.next("state");
  assert.ok((state.c as unknown[]).some((cursor) => Array.isArray(cursor) && cursor[0] === firstSlot));
  first.send({ t: "reaction", id: "tap-a", x: 30000, y: 30000, k: 1 });
  const reaction = await second.next("reaction");
  assert.equal(reaction.s, firstSlot);
  first.send({ t: "not-a-message" });
  assert.equal((await first.next("error")).code, "unknown-type");
  first.close();
  await wait(100);
  const resumed = new TestClient(first.id, first.name); await resumed.open(); resumed.send(hello);
  const resumedWelcome = await resumed.next("welcome"); assert.equal(resumedWelcome.resumed, true); assert.equal(resumedWelcome.slot, firstSlot);
  resumed.send({ t: "cursor", q: 1, x: 50000, y: 50000 });
  const resumedState = await second.next("state"); assert.ok((resumedState.c as unknown[]).some((cursor) => Array.isArray(cursor) && cursor[0] === firstSlot));
  second.close(); resumed.close();
  console.log("integration: join, state relay, reaction, malformed rejection, and reconnect passed");
}

try { await main(); } finally { server.kill("SIGTERM"); }
