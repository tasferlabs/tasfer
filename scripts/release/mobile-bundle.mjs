// Pack the web build into the bundle the iOS and Android apps download over
// the air, and write the manifest that tells them about it. The app side is
// apps/web/src/platform/mobileUpdate.ts.
//
// Run after `npm run build` in apps/web:
//   node scripts/release/mobile-bundle.mjs --out <dir> [--published <manifest>]
//
// It writes two files into <dir>:
//   tasfer-web-<appVersion>.zip   the web build, without source maps
//   mobile-bundle.json            { version, minNativeVersion, file, sha256, ... }
//
// --published is the manifest that is live right now, when there is one. With
// it the script refuses to publish a version older than the live one, and
// writes nothing when this version is already live — an app that already runs
// a version never downloads it again, so a second upload could not reach
// anyone. Bump appVersion in version.json to ship again.
//
// Two numbers in /version.json drive this:
//   appVersion        the bundle's version. Apps take a bundle only when it is
//                     newer than the web code they are running.
//   minNativeVersion  the oldest native app (store build) the bundle runs on.
//                     Raise it to the next store version whenever the web code
//                     starts to need something only a newer native app has: a
//                     new or changed Swift/Kotlin bridge, a new Capacitor
//                     plugin, a capacitor.config.js change. Older apps then
//                     skip the bundle and send the person to the store, so
//                     publish it only once that store build is live.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { appVersion, repoRoot } from "./app-version.mjs";

const SEMVER = /^\d+\.\d+\.\d+$/;

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Oldest native app version this bundle runs on, from /version.json. */
function minNativeVersion(version) {
  const { minNativeVersion: min } = JSON.parse(
    readFileSync(resolve(repoRoot, "version.json"), "utf8"),
  );
  if (typeof min !== "string" || !SEMVER.test(min)) {
    throw new Error(
      `version.json: minNativeVersion must be a bare major.minor.patch semver, got ${JSON.stringify(min)}`,
    );
  }
  if (compareVersions(min, version) > 0) {
    throw new Error(
      `version.json: minNativeVersion '${min}' is newer than appVersion '${version}' — no native app could run this bundle`,
    );
  }
  return min;
}

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else visit(path);
  }
}

/**
 * Warn when native code changed since the live bundle was built but
 * minNativeVersion did not move. Not every native change breaks older apps, so
 * this only asks the question; it never fails the run.
 */
function warnOnNativeChanges(published, minNative) {
  if (!published?.commit || published.minNativeVersion !== minNative) return;
  let changed;
  try {
    changed = execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        published.commit,
        "HEAD",
        "--",
        "apps/ios",
        "apps/android",
        "apps/web/capacitor.config.js",
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return; // The live bundle's commit is not in this checkout.
  }
  if (!changed) return;
  const files = changed.split("\n");
  const shown = files.slice(0, 10).join(", ");
  console.log(
    `::warning::Native files changed since the live bundle (${published.version}) but minNativeVersion is still ${minNative}. ` +
      `If the web code now needs any of these changes, raise minNativeVersion in version.json so older apps skip this bundle. ` +
      `Changed: ${shown}${files.length > 10 ? `, and ${files.length - 10} more` : ""}`,
  );
}

const outDir = option("--out");
if (!outDir) {
  console.error(
    "usage: node scripts/release/mobile-bundle.mjs --out <dir> [--published <manifest>]",
  );
  process.exit(2);
}

const version = appVersion();
const minNative = minNativeVersion(version);

const publishedPath = option("--published");
const published =
  publishedPath && existsSync(publishedPath)
    ? JSON.parse(readFileSync(publishedPath, "utf8"))
    : null;
if (published && SEMVER.test(published.version ?? "")) {
  const order = compareVersions(version, published.version);
  if (order < 0) {
    throw new Error(
      `the live bundle is ${published.version}, newer than appVersion ${version} — refusing to publish an older bundle`,
    );
  }
  if (order === 0) {
    console.log(
      `::notice::Bundle ${version} is already live — nothing to publish. Bump appVersion in version.json to ship a new one.`,
    );
    process.exit(0);
  }
}
warnOnNativeChanges(published, minNative);

const distDir = resolve(repoRoot, "apps/web/dist");
if (!existsSync(join(distDir, "index.html"))) {
  throw new Error(
    `${distDir} has no index.html — run \`npm run build\` in apps/web first`,
  );
}

// Files the phone apps never load. Keep this list in step with the trimming
// in apps/web/scripts/build-and-sync.sh, which does the same for the copy
// inside the store build.
//   .map              source maps: a large share of the download, and they
//                     hand out the readable source
//   screenshots/      only for the browser's install prompt (manifest.json)
//   .woff             every @font-face lists the .woff2 first, which every
//                     phone web view reads; the .woff is a fallback for old
//                     desktop browsers
//   hunspell-*.wasm   Vite's hashed copy of the spell checker; the app loads
//                     app/spell/hunspell.wasm instead (see vite.config.ts)
// None of these are in the service worker's precache list, so leaving them
// out cannot break its install on Android.
function unusedOnPhones(relPath) {
  const path = relPath.split(sep).join("/");
  return (
    path.endsWith(".map") ||
    path === "screenshots" ||
    path.startsWith("screenshots/") ||
    path.endsWith(".woff") ||
    /(^|\/)hunspell-[^/]*\.wasm$/.test(path)
  );
}

// Dangling source-map trailers would log a failed fetch per chunk.
const staging = mkdtempSync(join(tmpdir(), "tasfer-mobile-bundle-"));
cpSync(distDir, staging, {
  recursive: true,
  filter: (source) => !unusedOnPhones(relative(distDir, source)),
});
walk(staging, (path) => {
  if (!path.endsWith(".js")) return;
  const source = readFileSync(path, "utf8");
  const trimmed = source.replace(/^\/\/# sourceMappingURL=.*\n?/gm, "");
  if (trimmed !== source) writeFileSync(path, trimmed);
});

mkdirSync(outDir, { recursive: true });
const file = `tasfer-web-${version}.zip`;
const zipPath = resolve(outDir, file);
rmSync(zipPath, { force: true });
// index.html must sit at the root of the zip, so zip from inside the folder.
execFileSync("zip", ["-r", "-q", "-X", zipPath, "."], {
  cwd: staging,
  stdio: "inherit",
});
rmSync(staging, { recursive: true, force: true });

let commit = process.env.GITHUB_SHA;
if (!commit) {
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    commit = undefined;
  }
}

const manifest = {
  version,
  minNativeVersion: minNative,
  file,
  sha256: createHash("sha256").update(readFileSync(zipPath)).digest("hex"),
  size: statSync(zipPath).size,
  commit,
};
writeFileSync(
  resolve(outDir, "mobile-bundle.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const megabytes = (manifest.size / 1024 / 1024).toFixed(1);
console.log(
  `mobile-bundle: ${file} (${megabytes} MB) for native apps ${minNative} and newer`,
);
