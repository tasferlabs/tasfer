// The CLI's version and release tag — both the app's, not its own.
//
// `tasfer` is the app without a screen, so it ships at `appVersion` and its
// binaries hang off the same `v<appVersion>` release the desktop builds upload
// into. There is no cliVersion field: one number, one tag, one release.
//
//   node scripts/release/cli-version.mjs             0.1.5
//   node scripts/release/cli-version.mjs --tag       v0.1.5
//   node scripts/release/cli-version.mjs --write     write it into apps/cli/package.json
//
// Bump by editing version.json's appVersion, then run --write and commit the
// manifest. The release workflow runs --write itself and the bundler stamps the
// same value into the binary, so a forgotten sync cannot ship a stale
// `tasfer --version`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { appVersion, repoRoot } from "./app-version.mjs";

/** The release tag the CLI's binaries hang off — the app's own. */
export function cliTag(version = appVersion()) {
  return `v${version}`;
}

/** Stamp `version` onto apps/cli/package.json. Returns true if it changed. */
export function writeCliVersion(version = appVersion()) {
  const path = resolve(repoRoot, "apps/cli/package.json");
  const json = JSON.parse(readFileSync(path, "utf8"));
  if (json.version === version) return false;
  json.version = version;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = appVersion();
  if (process.argv.includes("--write")) {
    console.log(
      writeCliVersion(version)
        ? `✓ @tasfer/cli set to ${version}`
        : `✓ @tasfer/cli already at ${version}`,
    );
  } else if (process.argv.includes("--tag")) {
    console.log(cliTag(version));
  } else {
    console.log(version);
  }
}
