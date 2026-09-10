import { useEffect, useRef, useState } from "react";
import { REACTION_KINDS, reactionKindFromIndex } from "../../shared/protocol";
import type { PeerInfo, ServerMessage } from "../../shared/protocol";
import { SyncConnection } from "./connection";
import { reactionIcons } from "./icons";
import { colorForPeer, SyncRenderer } from "./render";

const roomFromUrl = new URLSearchParams(window.location.search).get("room") || "watch-party-42";
const storedId = sessionStorage.getItem("pulse-client-id") || crypto.randomUUID();
sessionStorage.setItem("pulse-client-id", storedId);

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SyncRenderer | null>(null);
  const connectionRef = useRef<SyncConnection | null>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.5 });
  const [name, setName] = useState(() => localStorage.getItem("pulse-name") || "Guest");
  const [roomId, setRoomId] = useState(roomFromUrl);
  const [status, setStatus] = useState("connecting");
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [selectedReaction, setSelectedReaction] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new SyncRenderer(canvasRef.current); rendererRef.current = renderer; renderer.draw(performance.now());
    if (!roomId) return () => { rendererRef.current = null; };
    const connection = new SyncConnection(roomId, storedId, name); connectionRef.current = connection;
    const offStatus = connection.on("status", setStatus);
    const offError = connection.on("error", setError);
    const offMessage = connection.on("message", (message: ServerMessage) => {
      if (message.t === "welcome") { renderer.setPresence(message.peers, message.slot); setPeers(message.peers); }
      if (message.t === "join") { setPeers((current) => [...current.filter((peer) => peer.slot !== message.peer.slot), message.peer]); }
      if (message.t === "status") setPeers((current) => current.map((peer) => peer.slot === message.slot ? { ...peer, online: message.online } : peer));
      if (message.t === "leave") { renderer.remove(message.slot); setPeers((current) => current.filter((peer) => peer.slot !== message.slot)); }
      renderer.handle(message);
    });
    connection.connect();
    return () => { offStatus(); offError(); offMessage(); connection.close(); connectionRef.current = null; rendererRef.current = null; };
  }, [roomId]);

  function join(event: React.FormEvent) { event.preventDefault(); localStorage.setItem("pulse-name", name.trim() || "Guest"); setRoomId(roomId.trim() || "watch-party-42"); }
  function leave() { connectionRef.current?.leave(); connectionRef.current = null; setPeers([]); setRoomId(""); }
  function sendReaction(x: number, y: number, kindIndex: number) { const kind = reactionKindFromIndex(kindIndex); const id = storedId + "-local-" + Date.now(); const ownPeer = peers.find((peer) => peer.clientId === storedId); rendererRef.current?.addLocalBurst(id, x, y, kind, ownPeer ? colorForPeer(ownPeer) : "#ffbd59"); connectionRef.current?.sendReaction(x, y, kindIndex); }
  function move(event: React.PointerEvent<HTMLCanvasElement>) { const rect = event.currentTarget.getBoundingClientRect(); const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)); const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)); pointerRef.current = { x, y }; connectionRef.current?.sendCursor(x, y); }
  function reactAt(event: React.MouseEvent<HTMLCanvasElement>) { const rect = event.currentTarget.getBoundingClientRect(); const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)); const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)); pointerRef.current = { x, y }; sendReaction(x, y, selectedReaction); }
  function chooseReaction(index: number) { setSelectedReaction(index); sendReaction(pointerRef.current.x, pointerRef.current.y, index); }
  const online = peers.filter((peer) => peer.online).length;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">+</span><span>pulse room</span></div>
        <div className="room-chip"><span className={status === "connected" ? "live-dot" : "live-dot muted"}></span>{status}<strong>/{roomId}</strong></div>
      </header>
      <section className="intro">
        <div><p className="eyebrow">LIVE SHARED SPACE</p><h1>Move together.<br /><em>Feel the room.</em></h1><p className="lede">A tiny, honest multiplayer canvas for the moments that happen between the big ones.</p></div>
        <form className="join-form" onSubmit={join}><label>YOUR NAME<input value={name} maxLength={24} onChange={(event) => setName(event.target.value)} /></label><label>ROOM<input value={roomId} maxLength={64} onChange={(event) => setRoomId(event.target.value)} /></label><button type="submit">Join room <span>↗</span></button></form>
      </section>
      <section className="workspace">
        <div className="canvas-wrap"><canvas ref={canvasRef} onPointerMove={move} onClick={reactAt} aria-label="Shared cursor canvas" /><div className="canvas-note"><span>Move your cursor through the room</span><span>Click to send a reaction</span></div></div>
        <aside className="presence">
          <div className="presence-head"><div><p className="eyebrow">IN THE ROOM</p><h2>{online} <span>connected</span></h2></div><span className="count">{peers.length.toString().padStart(2, "0")}</span></div>
          <div className="peer-list">{peers.map((peer) => <div className="peer" key={peer.slot}><span className={peer.online ? "presence-dot" : "presence-dot away"} style={{ backgroundColor: colorForPeer(peer) }}></span><span className="peer-name">{peer.name}{peer.clientId === storedId ? " (you)" : ""}</span><span className="peer-state">{peer.online ? "LIVE" : "AWAY"}</span></div>)}</div>
          <div className="reaction-panel"><p className="eyebrow">SEND A SIGNAL</p><div className="reaction-grid">{REACTION_KINDS.map((kind, index) => <button type="button" className={selectedReaction === index ? "reaction selected" : "reaction"} key={kind} onClick={() => chooseReaction(index)} aria-label={kind} title={kind}><svg viewBox="0 0 24 24"><path d={reactionIcons[kind]} /></svg></button>)}</div></div>
          {roomId && <button type="button" className="leave-button" style={{ width: "100%", marginTop: 22, padding: "11px 14px", border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", font: "11px 'DM Mono', monospace", letterSpacing: ".1em", textTransform: "uppercase", cursor: "pointer" }} onClick={leave}>Exit watch party</button>}
          {error && <p className="error">{error}</p>}
        </aside>
      </section>
      <footer><span>RAW WEBSOCKET SYNC</span><span>20 Hz state tick · buffered interpolation · reconnect grace</span></footer>
    </main>
  );
}
