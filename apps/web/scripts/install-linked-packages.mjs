// vite.config.ts aliases @tasfer/* to sibling package *source*, so their
// runtime deps (e.g. lowlight, turndown) resolve from each package's own
// node_modules. Install those alongside web's install so a fresh clone works.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Keep in sync with the `@tasfer/*` aliases in vite.config.ts / vitest.config.ts:
// each aliased package is compiled from source here, so its own install must
// have run (code pulls lowlight, editor pulls turndown).
const linkedPackages = [
  "editor",
  "math",
  "code",
  "table",
  "tex",
  "react",
  "provider-core",
  "spell",
];

for (const name of linkedPackages) {
  const dir = resolve(repoRoot, "packages", name);
  if (!existsSync(resolve(dir, "package.json"))) {
    console.error(`[install-linked-packages] missing package: ${dir}`);
    process.exit(1);
  }
  console.log(`[install-linked-packages] packages/${name}`);
  const result = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
