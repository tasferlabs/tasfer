// The Hunspell WebAssembly binary ships with the `hunspell-wasm` dependency of
// packages/spell. Copy it next to the dictionaries under public/app/spell so
// the spell worker loads engine and dictionaries from the same place on the
// web (runtime-cached by the service worker), in Electron (file:// bundle) and
// in the Capacitor shells. The copy is gitignored; this runs on install and
// before every build so it always matches the installed package version.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(
  here,
  "../../../packages/spell/node_modules/hunspell-wasm/wasm/hunspell.wasm",
);
const target = resolve(here, "../public/app/spell/hunspell.wasm");

if (!existsSync(source)) {
  console.error(
    `[copy-spell-wasm] missing ${source} — run \`npm install\` in packages/spell first`,
  );
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(
  `[copy-spell-wasm] public/app/spell/hunspell.wasm (${statSync(target).size} bytes)`,
);
