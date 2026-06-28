/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __BUILD_TIMESTAMP__: string;

interface SyncManager {
  register(tag: string): Promise<void>;
}

interface ServiceWorkerRegistration {
  sync?: SyncManager;
}

interface ImportMetaEnv {
  readonly VITE_STAGING?: string;
  readonly VITE_SIGNAL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
