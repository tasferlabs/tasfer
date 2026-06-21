/**
 * Build-time dev flag — the single home for it. True in development builds
 * (Vite/tsdown set `import.meta.env.DEV`) and tree-shaken to `false` in
 * production. Guards dev-only diagnostics that must add zero cost to a shipped
 * build, e.g. the incremental-vs-rebuilt state cross-check in `sync/oplog.ts`
 * and the unknown-action-name warning in `entries/editor.ts`.
 */
export const IS_DEV =
  typeof import.meta !== "undefined" && !!import.meta.env?.DEV;
