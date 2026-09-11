import { useEffect, useRef, useState } from "react";
import { REACTION_KINDS, reactionKindFromIndex } from "../../shared/protocol";
import type { PeerInfo, ServerMessage } from "../../shared/protocol";
import { SyncConnection } from "./connection";
import { reactionIcons } from "./icons";
import { colorForPeer, SyncRenderer } from "./render";

const roomFromUrl = new URLSearchParams(window.location.search).get("room") || "";
const storedId = sessionStorage.getItem("pulse-client-id") || crypto.randomUUID();
sessionStorage.setItem("pulse-client-id", storedId);

/** Three-step signal quality shown next to the RTT readout. */
function signalLevel(rtt: number): number { return rtt <= 0 || rtt < 90 ? 3 : rtt < 220 ? 2 : 1; }
function initials(name: string): string { return (name.trim()[0] ?? "?").toUpperCase(); }

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SyncRenderer | null>(null);
  const connectionRef = useRef<SyncConnection | null>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.5 });
  const [name, setName] = useState(() => localStorage.getItem("pulse-name") || "Guest");
  const [roomId, setRoomId] = useState(roomFromUrl);
  const [hasJoined, setHasJoined] = useState(false);
  const [status, setStatus] = useState("idle");
  const [network, setNetwork] = useState({ rtt: 0, jitter: 0 });
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [selectedReaction, setSelectedReaction] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new SyncRenderer(canvasRef.current); rendererRef.current = renderer; renderer.draw(performance.now());
    if (!hasJoined || !roomId) return () => { renderer.stop(); rendererRef.current = null; };
    const connection = new SyncConnection(roomId, storedId, name); connectionRef.current = connection;
    const offStatus = connection.on("status", setStatus);
    const offError = connection.on("error", setError);
    const offNetwork = connection.on("network", setNetwork);
    const offMessage = connection.on("message", (message: ServerMessage) => {
      if (message.t === "welcome") { renderer.setPresence(message.peers, message.slot); setPeers(message.peers); }
      if (message.t === "join") { renderer.upsertPeer(message.peer); setPeers((current) => [...current.filter((peer) => peer.slot !== message.peer.slot), message.peer]); }
      if (message.t === "status") { renderer.setPeerOnline(message.slot, message.online); setPeers((current) => current.map((peer) => peer.slot === message.slot ? { ...peer, online: message.online } : peer)); }
      if (message.t === "leave") { renderer.remove(message.slot); setPeers((current) => current.filter((peer) => peer.slot !== message.slot)); }
      renderer.handle(message);
    });
    connection.connect();
    return () => { offStatus(); offError(); offNetwork(); offMessage(); connection.close(); connectionRef.current = null; renderer.stop(); rendererRef.current = null; setNetwork({ rtt: 0, jitter: 0 }); };
  }, [roomId, hasJoined]);

  function join(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = roomId.trim();
    if (!trimmed) return;
    localStorage.setItem("pulse-name", name.trim() || "Guest");
    const url = new URL(window.location.href); url.searchParams.set("room", trimmed); history.replaceState(null, "", url);
    setRoomId(trimmed);
    setHasJoined(true);
  }
  function leave() { connectionRef.current?.leave(); connectionRef.current = null; setPeers([]); setHasJoined(false); }
  function copyInvite() {
    const url = new URL(window.location.href); url.searchParams.set("room", roomId);
    navigator.clipboard?.writeText(url.toString()).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => setError("Could not copy the invite link"));
  }
  function sendReaction(x: number, y: number, kindIndex: number) { const kind = reactionKindFromIndex(kindIndex); const id = storedId + "-local-" + Date.now(); const ownPeer = peers.find((peer) => peer.clientId === storedId); rendererRef.current?.addLocalBurst(id, x, y, kind, ownPeer ? colorForPeer(ownPeer) : "#ffbd59"); connectionRef.current?.sendReaction(x, y, kindIndex); }
  function move(event: React.PointerEvent<HTMLCanvasElement>) { const rect = event.currentTarget.getBoundingClientRect(); const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)); const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)); pointerRef.current = { x, y }; connectionRef.current?.sendCursor(x, y); }
  function reactAt(event: React.MouseEvent<HTMLCanvasElement>) { const rect = event.currentTarget.getBoundingClientRect(); const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)); const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)); pointerRef.current = { x, y }; sendReaction(x, y, selectedReaction); }
  function chooseReaction(index: number) { setSelectedReaction(index); sendReaction(pointerRef.current.x, pointerRef.current.y, index); }
  const online = peers.filter((peer) => peer.online).length;
  const connected = status === "connected";

  return (
    <>
      <div className="ambient" aria-hidden="true" />
      <main className="shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true"><i /></span>
            <span className="brand-text">pulse<span>room</span></span>
          </div>
          <div className="topbar-meta">
            <div className={connected ? "chip room-chip is-connected" : "chip room-chip"}>
              <span className="live-dot" />
              {status}
              {hasJoined && <><span className="sep">/</span><strong>{roomId}</strong></>}
            </div>
            {hasJoined && <button type="button" className={copied ? "copy-link done" : "copy-link"} onClick={copyInvite}>{copied ? "link copied" : "copy invite"}</button>}
            {connected && (
              <div className="chip net-chip" title="Application-level round trip time to the server, and its jitter (smoothed)">
                <span className="bars" data-level={signalLevel(network.rtt)} aria-hidden="true"><i /><i /><i /></span>
                <span><b>{network.rtt}</b>ms rtt</span>
                <span className="sep">·</span>
                <span><b>{network.jitter}</b>ms jitter</span>
              </div>
            )}
          </div>
        </header>
        {!hasJoined && (
          <section className="intro">
            <div className="intro-copy">
              <p className="eyebrow">Live shared space</p>
              <h1>Move together.<br /><em>Feel the room.</em></h1>
              <p className="lede">A tiny, honest multiplayer canvas for the moments that happen between the big ones. Raw WebSockets, no sync library.</p>
              <ul className="facts">
                <li><strong>20 Hz</strong><span>state tick</span></li>
                <li><strong>75 ms</strong><span>interpolation buffer</span></li>
                <li><strong>0</strong><span>sync libraries</span></li>
              </ul>
            </div>
            <form className="join-form" onSubmit={join}>
              <p className="form-title">Join a room</p>
              <label>Your name<input value={name} maxLength={24} onChange={(event) => setName(event.target.value)} /></label>
              <label>Room code<input value={roomId} maxLength={64} placeholder="watch-party-42" onChange={(event) => setRoomId(event.target.value)} /></label>
              <button type="submit" disabled={!roomId.trim()}>Join room <span>↗</span></button>
              <p className="form-hint">Open the same code in a few tabs, or share the invite link once you are inside.</p>
            </form>
          </section>
        )}
        {hasJoined && (
          <section className="workspace">
            <div className="canvas-wrap">
              <canvas ref={canvasRef} onPointerMove={move} onClick={reactAt} aria-label="Shared cursor canvas" />
              <div className="canvas-note"><span>Move your cursor through the room</span><span>Click to send a reaction</span></div>
            </div>
            <aside className="presence">
              <div className="presence-head">
                <div>
                  <p className="eyebrow">In the room</p>
                  <h2>{online} <span>connected</span></h2>
                </div>
                <span className="count">{peers.length.toString().padStart(2, "0")}</span>
              </div>
              <div className="peer-list">
                {peers.length === 0 && <p className="peer-empty">Waiting for the room to fill. Open this link in another tab to see presence sync.</p>}
                {peers.map((peer) => (
                  <div className={peer.online ? "peer is-live" : "peer is-away"} key={peer.slot}>
                    <span className="avatar" style={{ backgroundColor: colorForPeer(peer) + "22", color: colorForPeer(peer), boxShadow: "inset 0 0 0 1px " + colorForPeer(peer) + "59" }}>{initials(peer.name)}</span>
                    <span className="peer-name">{peer.name}{peer.clientId === storedId && <em> (you)</em>}</span>
                    <span className="peer-state">{peer.online ? "LIVE" : "AWAY"}</span>
                  </div>
                ))}
              </div>
              <div className="reaction-panel">
                <p className="eyebrow">Send a signal</p>
                <div className="reaction-grid">{REACTION_KINDS.map((kind, index) => <button type="button" className={selectedReaction === index ? "reaction selected" : "reaction"} key={kind} onClick={() => chooseReaction(index)} aria-label={kind} aria-pressed={selectedReaction === index} title={kind}><svg viewBox="0 0 24 24"><path d={reactionIcons[kind]} /></svg></button>)}</div>
              </div>
              <button type="button" className="leave-button" onClick={leave}>Exit watch party</button>
              {error && <p className="error">{error}</p>}
            </aside>
          </section>
        )}
        <footer><span>Raw WebSocket sync</span><span>20 Hz state tick · buffered interpolation · reconnect grace</span></footer>
      </main>
    </>
  );
}
