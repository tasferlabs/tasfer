/**
 * Build the release archive for the platform this runs on.
 *
 *   node scripts/build-binary.mjs [--out build]
 *
 * Produces `build/tasfer-<version>-<platform>-<arch>/`:
 *
 *   tasfer            Node's own executable with our bundle injected (SEA)
 *   node_modules/     better-sqlite3 and node-datachannel, prebuilt for here
 *
 * Two files rather than one because a prebuilt `.node` cannot live inside a
 * single executable; `src/host/native.ts` resolves them from beside it. The
 * release workflow runs this once per platform and tars the directory up.
 *
 * Cross-compilation is not a thing here: a SEA is the running Node binary with
 * a blob appended, and the native modules are fetched for the host. Each
 * platform builds its own artifact on its own runner.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliRoot, "../..");

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", ...options });

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const { appVersion } = JSON.parse(
  readFileSync(join(repoRoot, "version.json"), "utf8"),
);
const manifest = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));

const name = `tasfer-${appVersion}-${process.platform}-${process.arch}`;
const outRoot = resolve(cliRoot, flag("out", "build"));
const outDir = join(outRoot, name);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ── 1. The bundle ────────────────────────────────────────────────────────────
console.log("▸ bundling");
run("npm", ["run", "build"], { cwd: cliRoot });

const bundle = join(cliRoot, "dist-sea/main.cjs");
if (!existsSync(bundle)) {
  throw new Error(`the SEA bundle is missing: ${bundle}`);
}

// ── 2. The executable ────────────────────────────────────────────────────────
// `node --experimental-sea-config` writes a blob; postject appends it to a copy
// of the Node binary, and the fuse tells that binary to run it instead of
// looking for a script argument.
console.log("▸ injecting");
const staging = join(outRoot, ".sea");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const seaConfig = join(staging, "sea-config.json");
const blob = join(staging, "tasfer.blob");
writeFileSync(
  seaConfig,
  JSON.stringify(
    { main: bundle, output: blob, disableExperimentalSEAWarning: true },
    null,
    2,
  ),
);
run(process.execPath, ["--experimental-sea-config", seaConfig]);

const binary = join(outDir, "tasfer");
copyFileSync(process.execPath, binary);
chmodSync(binary, 0o755);

// macOS refuses to run a signed binary whose contents changed, so the existing
// signature comes off before injection and an ad-hoc one goes back on after.
// A Developer ID in MAC_SIGN_IDENTITY replaces the ad-hoc signature, which is
// what a downloaded release needs to clear Gatekeeper.
if (process.platform === "darwin") {
  run("codesign", ["--remove-signature", binary]);
}

run("npx", [
  "--yes",
  "postject",
  binary,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin"
    ? ["--macho-segment-name", "NODE_SEA"]
    : []),
]);

if (process.platform === "darwin") {
  const identity = process.env.MAC_SIGN_IDENTITY || "-";
  run("codesign", ["--sign", identity, "--force", "--timestamp", binary]);
}

rmSync(staging, { recursive: true, force: true });

// ── 3. The native modules ────────────────────────────────────────────────────
// Installed rather than copied: npm resolves each one's own dependencies and
// fetches the prebuilt binary for this platform, which a file copy from a dev
// machine would not.
console.log("▸ fetching native modules");
const specs = ["better-sqlite3", "node-datachannel"].map((pkg) => {
  const range =
    manifest.dependencies?.[pkg] ?? manifest.optionalDependencies?.[pkg];
  if (!range) throw new Error(`${pkg} is not a dependency of @tasfer/cli`);
  return `${pkg}@${range}`;
});

writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify({ name: "tasfer-runtime", private: true }, null, 2) + "\n",
);
run("npm", [
  "install",
  "--omit=dev",
  "--no-package-lock",
  "--no-audit",
  "--no-fund",
  ...specs,
], { cwd: outDir });
rmSync(join(outDir, "package.json"), { force: true });

// npm also pulled better-sqlite3's install-time toolchain (prebuild-install and
// its ~35 transitive packages). None of it is reachable at runtime, so drop
// everything the two modules do not actually load.
const KEEP = new Set([
  "better-sqlite3",
  "bindings",
  "file-uri-to-path",
  "node-datachannel",
  "@node-datachannel",
  ".package-lock.json",
]);
const modules = join(outDir, "node_modules");
for (const entry of readdirSync(modules)) {
  if (KEEP.has(entry)) continue;
  rmSync(join(modules, entry), { recursive: true, force: true });
}
rmSync(join(modules, ".bin"), { recursive: true, force: true });

console.log(`✓ ${outDir}`);
