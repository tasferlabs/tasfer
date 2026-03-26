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

declare module "wa-sqlite/dist/wa-sqlite.mjs" {
  const factory: () => Promise<any>;
  export default factory;
}

declare module "wa-sqlite/src/examples/AccessHandlePoolVFS.js" {
  export class AccessHandlePoolVFS {
    constructor(directoryPath: string);
    isReady: Promise<void>;
    addCapacity(n: number): Promise<number>;
    removeCapacity(n: number): Promise<number>;
    getCapacity(): number;
  }
}
