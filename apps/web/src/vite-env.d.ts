/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __BUILD_TIMESTAMP__: string;

interface ImportMetaEnv {
  readonly VITE_WEBSOCKET_URL?: string;
  readonly VITE_STAGING?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
