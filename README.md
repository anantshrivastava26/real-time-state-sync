# Pulse Room

A small real-time multiplayer cursor and reaction room built on the browser WebSocket API and a hand-written RFC 6455 server. There is no `ws`, Socket.IO, or state-sync library.

## Run it

Requirements: Node 20+.

```bash
npm install
npm run dev
```

Open `http://localhost:5173/?room=watch-party-42` in 3-5 browser tabs. Give each tab a different name. Move the pointer to share a cursor and click the canvas to send the selected signal. The server health endpoint is `http://localhost:8787/health`.

For a production-style single process:

```bash
npm run build
npm start
```

The server serves `client/dist` after the build.

## Protocol and sync model

All wire messages are JSON text frames validated by `shared/protocol.ts`. Positions use normalized 16-bit coordinates. The client sends cursor samples at most 30 Hz, with a movement epsilon; the server coalesces them into one state frame per room tick at 20 Hz. Reactions bypass the tick and are relayed immediately. A complete `welcome` snapshot gives joining clients presence and a first cursor state; later cursor frames are deltas.

Each cursor has a monotonically increasing connection sequence number. The server drops stale sequence numbers, and clients drop state samples that do not advance in server timestamp order. Unknown or malformed messages produce a bounded error response and repeated bad input is closed.

## Interpolation

Remote cursor samples are kept in a bounded 24-sample buffer. Rendering is normally 75 ms behind the server clock, which leaves one or two 50 ms state intervals to interpolate across. The delay adapts upward when arrival jitter is observed, capped at 300 ms. If the buffer runs dry, motion is extrapolated for at most 120 ms, then held at the latest position.

The tradeoff is intentional: about 75-150 ms of visual delay buys stable motion under ordinary jitter. Cursor transport itself remains lossy and current-value-only, so a congested client does not create an unbounded server queue.

## Latency visibility

The client already sends an application-level `ping{c}` every second and the server echoes it back as `pong{c,ts}` off the tick, purely so RTT can be measured; nothing used the reply before. It now does: `connection.ts` turns each pong into a round trip sample (`now - c`, no clock sync required) and folds it into two exponential moving averages -- RTT and mean absolute jitter -- with no history buffer. The topbar shows the live numbers while connected. This is self-only: it reports this client's RTT to the server, not other peers' RTT to each other, since the server never relays it and this room has no peer-to-peer path to measure directly. Broadcasting everyone's RTT to everyone was considered and skipped -- it needs a new message type and a periodic broadcast, and it exposes each viewer's network quality to every other viewer for a bonus readout, which is a worse trade than it looks.

Adaptive throttling of the cursor send rate from this same RTT signal was also considered and skipped. Cursor packets are already small and capped at 30 Hz, so the payoff is marginal at the 3-10 client scale this assignment targets, and a server-side version would mean per-recipient decimation instead of the current single-encode, write-to-every-socket tick -- more moving parts for a control loop that also has to be damped against oscillation.

## Failure handling and limitations

The server sends protocol ping frames every 5 seconds and closes silent connections after 12 seconds. A dropped peer becomes `AWAY` immediately and its slot is retained for 5 seconds; reconnecting with the same client ID resumes that slot and cursor state. A clean leave removes it immediately. The client reconnects with exponential backoff.

This is a single-process demo: no persistence across restart, no authentication or room access control, and no horizontal scaling. A production multi-instance deployment would put room ownership behind a shared broker or route each room consistently to one process, while preserving the same room protocol.

The hand-written WebSocket implementation intentionally omits compression and outbound fragmentation. It supports the small JSON messages needed here, masks client frames, handles fragmentation, control frames, backpressure, and close handshakes.

## Verification

```bash
npm run typecheck
npm run build
npm test
```

The integration test opens two raw clients and checks join, cursor relay, reaction relay, malformed-message rejection, and reconnect identity. Time spent: approximately 4 hours.

AI tools were used for implementation assistance and review. The protocol, server ownership model, interpolation strategy, and tests were checked against the source before completion.
