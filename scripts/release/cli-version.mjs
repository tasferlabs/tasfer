// The CLI's version and release tag — both the app's, not its own.
//
// `tasfer` is the app without a screen, so it ships at `appVersion` and its
// binaries hang off the same `v<appVersion>` release the desktop builds upload
// into. There is no cliVersion field: one number, one tag, one release.
//
//   node scripts/release/cli-version.mjs             0.1.5
//   node scripts/release/cli-version.mjs --tag       v0.1.5
//
// Bump by editing version.json's appVersion — that is the whole edit. Nothing
// stamps a manifest: apps/cli/package.json is private, never published, and
// carries no version, and `tasfer --version` comes from the bundler's define
// (see apps/cli/tsdown.config.ts), read straight from version.json. So there is
// no second copy that could go stale, and nothing to write or commit.
import { fileURLToPath } from "node:url";
import { appVersion } from "./app-version.mjs";

/** The release tag the CLI's binaries hang off — the app's own. */
export function cliTag(version = appVersion()) {
  return `v${version}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = appVersion();
  console.log(process.argv.includes("--tag") ? cliTag(version) : version);
}
