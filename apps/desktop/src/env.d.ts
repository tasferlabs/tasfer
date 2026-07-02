// Ambient types for the env vars electron-vite injects into `import.meta.env`.
// Only `MAIN_VITE_`-prefixed vars from apps/desktop/.env reach the main process.

interface ImportMetaEnv {
  /**
   * Dev-server URL for the renderer to load in development. Set in
   * apps/desktop/.env to point the desktop app at a LAN `npm run dev:host`
   * server on another device (e.g. https://192.168.68.55:4000). Undefined in
   * production builds. See .env.example.
   */
  readonly MAIN_VITE_DEV_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
