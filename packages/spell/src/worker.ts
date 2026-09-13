/**
 * `@tasfer/spell/worker` — the worker-side host. Kept as a one-line shim so
 * the subpath resolves both from the built `dist/` and from source aliases
 * (`@tasfer/spell/*` → `src/*`) the way apps/web consumes the package.
 */
export * from "./worker-host";
