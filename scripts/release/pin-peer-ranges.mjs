// Pin intra-repo peer ranges before `npm publish`.
//
// In the source tree, sibling packages declare each other as peerDependencies
// with "*" (apps consume package sources directly, so any range is honest
// there). Published tarballs must not ship "*" — consumers could pair
// arbitrary versions. This rewrites every peer entry that names a sibling
// package to ^<that sibling's current version>. Run only in the publish
// workflow; the changes are not meant to be committed.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const packagesDir = new URL("../../packages/", import.meta.url).pathname;

const dirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(packagesDir, e.name, "package.json"))
  .filter((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });

const manifests = dirs.map((path) => ({
  path,
  json: JSON.parse(readFileSync(path, "utf8")),
}));
const versionByName = new Map(
  manifests.map(({ json }) => [json.name, json.version]),
);

for (const { path, json } of manifests) {
  const peers = json.peerDependencies;
  if (!peers) continue;
  let changed = false;
  for (const name of Object.keys(peers)) {
    // A name absent from the map is an outside peer (typescript, react) and is
    // left alone. A sibling that is present but carries no version means
    // package-version.mjs --write has not run: the manifests hold no literal of
    // their own. Refuse rather than leave the peer at "*", which is the one
    // range a published tarball must never ship.
    if (!versionByName.has(name)) continue;
    const version = versionByName.get(name);
    if (!version) {
      throw new Error(
        `${json.name}: sibling ${name} has no version — run scripts/release/package-version.mjs --write before pinning peer ranges`,
      );
    }
    const range = `^${version}`;
    if (peers[name] !== range) {
      peers[name] = range;
      changed = true;
      console.log(`${json.name}: peer ${name} -> ${range}`);
    }
  }
  if (changed) writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}
