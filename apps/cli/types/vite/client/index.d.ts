/**
 * Stub for `vite/client`.
 *
 * `packages/editor/src/env.ts` references it for `import.meta.env`, and the
 * CLI bundles that source with no Vite anywhere in the picture. The real
 * declaration types `env` as always present; here it is optional, which is the
 * truth under plain Node and is what the two `import.meta.env?.` reads in the
 * shared sources are written against.
 */

interface ImportMetaEnv {
  readonly DEV?: boolean;
  readonly VITE_STAGING?: string;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}
