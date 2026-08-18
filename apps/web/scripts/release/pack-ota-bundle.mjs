#!/usr/bin/env node
//
// Pack apps/web/dist into a live-update (OTA) bundle for @capgo/capacitor-updater.
//
// Usage (from apps/web):
//   npm run build:ota
//
// Output, under <repo>/build/ota/:
//   <version>.zip     the whole bundle, for a device that has nothing to reuse
//   payload/          the stripped file tree the per-file manifest refers to
//   bundle.json       version, minBuiltin, checksum, and the file manifest
//
// Encryption is opt-in: set CAPGO_PRIVATE_KEY to the private key's PEM text (or
// CAPGO_PRIVATE_KEY_FILE to its path) and the zip is encrypted with capgo's CLI
// and `sessionKey` is emitted alongside. Without it the bundle ships plain —
// still checksummed and still fetched over TLS from our own origin, but the
// integrity guarantee is "our server said so" rather than "our signing key said
// so".
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = resolve(webDir, "../..");
const distDir = join(webDir, "dist");
const outDir = join(root, "build", "ota");

const fail = (message) => {
  console.error(`pack-ota-bundle: ${message}`);
  process.exit(1);
};

// A Vercel build is a DIFFERENT build. vite.config.ts branches on VERCEL: the
// web deploy gets the microfrontends base `/app`, the native build gets
// `base: "./"`. A bundle carrying absolute /app/... asset URLs cannot boot from
// the device filesystem, and it fails at runtime on the device, not here — so
// refuse rather than produce one.
if (process.env.VERCEL) {
  fail("refusing to run inside a Vercel build — the OTA bundle needs the native (base: './') build");
}

if (!existsSync(join(distDir, "index.html"))) {
  fail("dist/index.html is missing — run `npm run build` first");
}

// The bundle version is this package's version — the same one
// capacitor.config.js stamps into the native build, so a store build and the
// bundles that succeed it sit on one ordered line. Bumping it is how a publish
// is declared: the server only offers a bundle strictly newer than what a
// device is running, so republishing at the same version is a no-op.
const { version } = JSON.parse(readFileSync(join(webDir, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  fail(
    `package.json version must be plain X.Y.Z, got ${JSON.stringify(version)}. ` +
      "Semver ranks a `-prerelease` below the release and ignores `+build`, so a " +
      "suffixed version would reach devices as a downgrade.",
  );
}

// The oldest store build this bundle runs on. Stays hand-set in version.json:
// it is a deliberate claim about native compatibility, not something a build
// can infer.
const { minBuiltin } = JSON.parse(readFileSync(join(root, "version.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(minBuiltin ?? "")) {
  fail(`version.json minBuiltin must be X.Y.Z, got ${JSON.stringify(minBuiltin)}`);
}

// Stage a copy. dist/ keeps its source maps: the web deploy and its error
// reporting still want them, and only the shipped bundle is stripped.
//
// The staged tree is kept rather than thrown away — it is what the per-file
// manifest names, and the publisher uploads individual files straight out of it.
mkdirSync(outDir, { recursive: true });
const payload = join(outDir, "payload");
rmSync(payload, { recursive: true, force: true });
cpSync(distDir, payload, { recursive: true });

// Same treatment the native bundle gets in scripts/build-and-sync.sh, for the
// same reasons: maps are a large share of the download and hand every user the
// readable source.
let stripped = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.endsWith(".map")) {
      rmSync(full);
      stripped++;
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".css")) {
      const text = readFileSync(full, "utf8");
      const next = text.replace(/^\/\/# sourceMappingURL=.*$\n?/gm, "")
        .replace(/^\/\*# sourceMappingURL=.*\*\/$\n?/gm, "");
      if (next !== text) writeFileSync(full, next);
    }
  }
};
walk(payload);

// Hidden files break unpacking on the device, and macOS sprinkles .DS_Store
// through any directory Finder has looked at.
const zipPath = join(outDir, `${version}.zip`);
rmSync(zipPath, { force: true });
execFileSync("zip", ["-q", "-r", "-X", zipPath, ".", "-x", ".*", "-x", "*/.*"], {
  cwd: payload,
  stdio: ["ignore", "inherit", "inherit"],
});

const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).split("\n");
if (!listing.includes("index.html")) {
  fail("index.html is not at the zip root — the device unpacks the zip and loads ./index.html");
}
const hidden = listing.filter((name) => name.split("/").some((part) => part.startsWith(".")));
if (hidden.length) {
  fail(`hidden entries would break unpacking: ${hidden.slice(0, 5).join(", ")}`);
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// Per-file manifest for delta updates. The device fetches only what it does not
// already have — matching first against its own built-in bundle, then its cache
// of previous bundles — so `file_name` MUST be the path as it appears inside
// the app's `public/` folder, and `file_hash` the SHA-256 of the file's plain
// bytes (verified on device against files that were never compressed).
const manifest = [];
const collect = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full);
    } else if (entry.isFile()) {
      manifest.push({
        file_name: relative(payload, full).split(sep).join("/"),
        file_hash: sha256(full),
      });
    }
  }
};
collect(payload);
if (!manifest.some((entry) => entry.file_name === "index.html")) {
  fail("manifest has no index.html at the bundle root");
}

let checksum = sha256(zipPath);
let sessionKey;

const privateKey = process.env.CAPGO_PRIVATE_KEY_FILE
  ? readFileSync(process.env.CAPGO_PRIVATE_KEY_FILE, "utf8")
  : process.env.CAPGO_PRIVATE_KEY;

if (privateKey) {
  // `bundle encrypt <zip> <sha256>` writes <name>_encrypted.zip and returns the
  // ivSessionKey plus the checksum to serve — which is the ENCRYPTED one, not
  // the plain zip's digest. Serving the plain digest for an encrypted bundle is
  // a silent integrity failure on device, so take both values from the CLI.
  const out = execFileSync(
    "npx",
    ["--yes", "@capgo/cli", "bundle", "encrypt", zipPath, checksum, "--key-data", privateKey, "--json"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  sessionKey = parsed.ivSessionKey ?? parsed.sessionKey;
  checksum = parsed.checksum ?? checksum;
  if (!sessionKey) fail("capgo bundle encrypt returned no session key");
} else {
  console.warn("pack-ota-bundle: CAPGO_PRIVATE_KEY not set — publishing an unencrypted bundle");
}

const meta = { version, minBuiltin, checksum, ...(sessionKey ? { sessionKey } : {}), manifest };
writeFileSync(join(outDir, "bundle.json"), `${JSON.stringify(meta, null, 2)}\n`);

const mb = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(
  `pack-ota-bundle: ${version} -> build/ota/${version}.zip (${mb} MB, ${stripped} source maps stripped)`,
);
console.log(
  `  ${manifest.length} files manifested  minBuiltin ${minBuiltin}  checksum ${checksum}${sessionKey ? "  encrypted" : ""}`,
);
