// The app's marketing version, read from /version.json — the one file that
// carries it. Every build (web, desktop, iOS, Android) derives its version from
// here; nothing else stores a literal.
//
// Run directly to print it, which is how shell and Gradle callers read it:
//   node scripts/release/app-version.mjs            0.1.1
//   node scripts/release/app-version.mjs --code     101
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Marketing version (`major.minor.patch`) from /version.json. */
export function appVersion() {
  const { appVersion: version } = JSON.parse(
    readFileSync(resolve(repoRoot, "version.json"), "utf8"),
  );
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `version.json: appVersion must be a bare major.minor.patch semver, got ${JSON.stringify(version)}`,
    );
  }
  return version;
}

/**
 * The integer build counter both stores need, packed from the semver so it
 * grows with every release without a second number to keep in sync
 * (1.4.2 -> 10402). Android calls it versionCode, iOS CURRENT_PROJECT_VERSION;
 * the same packing lives in apps/android/app/build.gradle, which reads
 * version.json itself rather than shelling out to node during configuration.
 *
 * The layout caps minor and patch at 99 — beyond that a build number would
 * collide with the next major/minor.
 */
export function buildNumber(version = appVersion()) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (minor > 99 || patch > 99) {
    throw new Error(
      `version.json: appVersion '${version}' — minor and patch must each be <= 99, ` +
        "otherwise the derived build number collides with the next major/minor",
    );
  }
  return major * 10000 + minor * 100 + patch;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(process.argv.includes("--code") ? buildNumber() : appVersion());
}
