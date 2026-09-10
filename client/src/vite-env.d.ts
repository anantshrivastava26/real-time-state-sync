/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** wss:// (or ws://) URL of the sync server, for deployments where the client and server are not the same host. */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
