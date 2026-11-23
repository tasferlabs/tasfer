/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __BUILD_TIMESTAMP__: string;
declare const __BUILD_COMMIT__: string;
declare const __APP_VERSION__: string;

interface SyncManager {
  register(tag: string): Promise<void>;
}

interface ServiceWorkerRegistration {
  sync?: SyncManager;
}

interface ImportMetaEnv {
  readonly VERCEL_ENV?: "production" | "preview" | "development";
  readonly VITE_STAGING?: string;
  readonly VITE_SIGNAL_URL?: string;
  /** Build-time override of the mobile bundle manifest, for testing updates. */
  readonly VITE_MOBILE_BUNDLE_MANIFEST_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
