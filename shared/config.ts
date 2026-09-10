/**
 * Tuning constants shared by client and server.
 *
 * These are deliberately in one place because several of them are coupled:
 * the client's render delay is derived from the server's tick rate, and the
 * server's liveness timeout must be larger than the client's ping interval.
 */

/** Server simulation/broadcast tick. 20 Hz = one state frame every 50 ms. */
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;

/** Client cursor sampling rate ceiling (adaptive; see `AdaptiveSendRate`). */
export const CURSOR_SEND_HZ_MAX = 30;
export const CURSOR_SEND_HZ_MIN = 10;

/**
 * Minimum normalized movement before a cursor sample is worth a packet.
 * ~1/1000th of the surface: below this, nobody can see the difference.
 */
export const CURSOR_MOVE_EPSILON = 0.001;

/** Application-level heartbeat used for RTT measurement (client -> server). */
export const APP_PING_INTERVAL_MS = 1000;

/** Protocol-level ping (server -> client) and the liveness deadline. */
export const WS_PING_INTERVAL_MS = 5000;
export const WS_LIVENESS_TIMEOUT_MS = 12_000;

/**
 * How long a peer keeps its slot in the room after its socket drops, so a
 * reconnecting client resumes its identity instead of appearing as a new peer.
 */
export const RECONNECT_GRACE_MS = 5000;

/** Client reconnect backoff bounds. */
export const RECONNECT_BACKOFF_MIN_MS = 250;
export const RECONNECT_BACKOFF_MAX_MS = 8000;

/** Interpolation: how far behind "now" remote cursors are rendered. */
export const RENDER_DELAY_MIN_MS = TICK_MS * 1.5; // 75 ms
export const RENDER_DELAY_MAX_MS = 300;

/** Max time we will invent motion for after the buffer runs dry. */
export const MAX_EXTRAPOLATION_MS = 120;

/** Per-peer sample ring buffer size. Bounds memory: ~1 s of history at 20 Hz. */
export const SAMPLE_BUFFER_SIZE = 24;

/** Reactions closer than this in time+space are merged into one combo. */
export const COMBO_WINDOW_MS = 700;
export const COMBO_RADIUS = 0.05;

/** Hard limits enforced by the server on anything a client sends. */
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_NAME_LENGTH = 24;
export const MAX_ROOM_ID_LENGTH = 64;
export const MAX_CLIENT_ID_LENGTH = 64;
export const MAX_PEERS_PER_ROOM = 64;

/** Token-bucket rate limit for inbound messages, per connection. */
export const INBOUND_RATE_LIMIT_PER_SEC = 120;
export const INBOUND_RATE_LIMIT_BURST = 240;
