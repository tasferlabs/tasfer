// The version the @tasfer/* libraries publish at, read from /version.json —
// the same file that carries the app's marketing version (see app-version.mjs).
// The libraries move in lockstep, so one field covers all of them; each manifest
// still stores a literal because npm publishes whatever package.json says.
//
//   node scripts/release/package-version.mjs            0.1.2
//   node scripts/release/package-version.mjs --write     write it into every manifest
//
// Bump by editing version.json, then run --write and commit the manifests it
// touches. The publish workflow runs --write itself, so a forgotten sync can
// never ship a stale version.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { repoRoot } from "./app-version.mjs";

/** Version (`major.minor.patch`) every published package carries. */
export function packagesVersion() {
  const { packagesVersion: version } = JSON.parse(
    readFileSync(resolve(repoRoot, "version.json"), "utf8"),
  );
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `version.json: packagesVersion must be a bare major.minor.patch semver, got ${JSON.stringify(version)}`,
    );
  }
  return version;
}

/**
 * Stamp `version` onto every packages/* manifest. Returns the names it changed.
 */
export function writePackageVersions(version = packagesVersion()) {
  const packagesDir = resolve(repoRoot, "packages");
  const changed = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(packagesDir, entry.name, "package.json");
    let json;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (json.version === version) continue;
    json.version = version;
    writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
    changed.push(json.name);
  }
  return changed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = packagesVersion();
  if (process.argv.includes("--write")) {
    const changed = writePackageVersions(version);
    for (const name of changed) console.log(`${name} -> ${version}`);
    console.log(
      changed.length
        ? `✓ ${changed.length} package(s) set to ${version}`
        : `✓ every package already at ${version}`,
    );
  } else {
    console.log(version);
  }
}
