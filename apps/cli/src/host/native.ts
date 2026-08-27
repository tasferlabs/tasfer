/**
 * Loading the two native modules, from wherever this build keeps them.
 *
 * A source checkout resolves them out of `apps/cli/node_modules` like any
 * other import. A released build is a single executable with no module tree
 * inside it — Node's SEA `require` serves built-ins and nothing else — so the
 * release archive puts `node_modules/` beside the executable and this resolves
 * from there.
 *
 * Both modules are CommonJS, so one `require` covers them; `node-datachannel`
 * is loaded through here rather than `import()` for exactly that reason.
 */

import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

/**
 * Whether this process is a released binary rather than `node dist/main.mjs`.
 * The executable is named `tasfer`; anything called `node` is a source run.
 */
export function isPackaged(): boolean {
  return basename(process.execPath) !== "node";
}

/**
 * `require` rooted where this build's `node_modules` lives. The path handed to
 * `createRequire` need not exist — resolution only walks up from its directory.
 */
const nativeRequire = createRequire(
  isPackaged() ? join(dirname(process.execPath), "tasfer.cjs") : import.meta.url,
);

/**
 * Load an optional native module, or return null when it is not installed.
 * Both callers treat absence as a degraded mode rather than an error: no
 * SQLite is fatal, no WebRTC only means relaying.
 */
export function loadNative<T>(specifier: string): T | null {
  try {
    return nativeRequire(specifier) as T;
  } catch {
    return null;
  }
}

/** Load a native module that the host cannot run without. */
export function requireNative<T>(specifier: string): T {
  return nativeRequire(specifier) as T;
}
