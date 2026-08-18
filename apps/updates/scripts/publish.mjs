#!/usr/bin/env node
//
// Publish a live-update (OTA) bundle, or re-point at one that is already
// published.
//
// Publishing uploads the artifact and makes it the current release:
//   node scripts/publish.mjs --zip ../../build/ota/0.1.4.zip \
//                            --meta ../../build/ota/bundle.json
//
// Re-pointing names a version that is ALREADY published, reading its metadata
// back out of R2 so the bytes served are provably the bytes that were built —
// no rebuild, no chance of drift. This is how a rollback is done:
//   node scripts/publish.mjs --version 0.1.3
//
// There is one release for everyone: no channels, no staged rollout, no
// per-platform split. Publishing is the decision.
//
// Flags: --local     act on the local wrangler state
//        --preview   use the preview KV namespace (local dev)
//        --dry-run   print what would be written, write nothing
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUCKET = "tasfer-ota-bundles";

const fail = (message) => {
  console.error(`publish: ${message}`);
  process.exit(1);
};

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) fail(`unexpected argument ${arg}`);
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i++;
  } else {
    args.set(key, true);
  }
}

const local = args.get("local") === true;
const preview = args.get("preview") === true;
const dryRun = args.get("dry-run") === true;
const scope = local ? "--local" : "--remote";
/** KV commands address the preview namespace separately from the real one. */
const kvScope = preview ? [scope, "--preview"] : [scope];

const wrangler = (argv, { capture = false } = {}) =>
  execFileSync("npx", ["wrangler", ...argv], {
    cwd: appDir,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"],
  });

/**
 * Content type to store alongside a bundle file.
 *
 * Not cosmetic: Cloudflare compresses responses in transit by content type, and
 * `application/octet-stream` is not on that list. Files are content-addressed,
 * so the type has to be stored at upload time — the download URL is a bare hash
 * and carries no extension to infer it from.
 */
const CONTENT_TYPES = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function contentTypeFor(fileName) {
  const dot = fileName.lastIndexOf(".");
  return (dot >= 0 && CONTENT_TYPES[fileName.slice(dot).toLowerCase()]) || "application/octet-stream";
}

/**
 * Upload one R2 object.
 *
 * Remote uploads go through the Cloudflare REST API rather than the wrangler
 * CLI: a bundle is ~250 files, and paying process startup for each of them
 * turns a few seconds of work into several minutes. Local runs keep using
 * wrangler, which is the only thing that can reach the local state.
 */
async function putObject(key, body, contentType) {
  if (local) {
    const scratch = mkdtempSync(join(tmpdir(), "tasfer-obj-"));
    const file = join(scratch, "object");
    try {
      writeFileSync(file, body);
      wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", contentType, scope]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    return;
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) fail("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");

  // Slashes in the key are sent literally; everything else is percent-encoded.
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${BUCKET}/objects/${encoded}`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      body,
    },
  );
  if (!res.ok) fail(`upload of ${key} failed: ${res.status} ${await res.text()}`);
}

/** Run `tasks` with a bounded number in flight. */
async function pooled(tasks, limit = 16) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]();
  });
  await Promise.all(workers);
}

function putKv(key, value) {
  const scratch = mkdtempSync(join(tmpdir(), "tasfer-kv-"));
  const file = join(scratch, "value.json");
  try {
    // Written from a file rather than an argv value: this is JSON with quotes
    // and braces, and shelling it through argv is how it eventually meets a
    // quoting rule it loses to.
    writeFileSync(file, value);
    wrangler(["kv", "key", "put", "--binding", "RELEASES", key, "--path", file, ...kvScope]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Metadata for the version being published or re-pointed at. */
let meta;

const zipPath = args.get("zip");
const metaPath = args.get("meta");

if (zipPath && metaPath) {
  meta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(meta.version ?? "")) fail("bundle.json has no usable version");

  console.log(`publish: uploading ${meta.version}`);
  await putObject(`bundles/${meta.version}.zip`, readFileSync(resolve(zipPath)), "application/zip");
  // The metadata rides along in R2 so a later re-point can reproduce this exact
  // release without the build that produced it.
  await putObject(`meta/${meta.version}.json`, readFileSync(resolve(metaPath)), "application/json");

  // Per-file objects for delta updates. Content-addressed, so a file shared
  // with an earlier version simply overwrites itself with identical bytes —
  // idempotent, which is why this does not bother asking what already exists.
  if (meta.manifest?.length) {
    const payloadDir = resolve(dirname(resolve(metaPath)), "payload");
    let uploaded = 0;
    await pooled(
      meta.manifest.map((entry) => async () => {
        await putObject(
          `files/${entry.file_hash}`,
          readFileSync(join(payloadDir, entry.file_name)),
          contentTypeFor(entry.file_name),
        );
        uploaded++;
        if (uploaded % 50 === 0) console.log(`publish:   ${uploaded}/${meta.manifest.length} files`);
      }),
    );
    console.log(`publish: ${meta.manifest.length} files uploaded`);

    // Keyed by version and never rewritten, so it stays cached at the edge
    // while the release pointer beside it churns.
    if (!dryRun) putKv(`manifest:${meta.version}`, JSON.stringify(meta.manifest));
  } else {
    console.warn("publish: bundle.json has no manifest — devices will download the whole zip");
  }
} else {
  const version = args.get("version");
  if (!version || version === true) fail("pass --zip and --meta to publish, or --version to re-point");

  const scratch = mkdtempSync(join(tmpdir(), "tasfer-repoint-"));
  const file = join(scratch, "meta.json");
  try {
    wrangler(["r2", "object", "get", `${BUCKET}/meta/${version}.json`, "--file", file, scope]);
    meta = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail(`no published metadata for ${version} — publish it before pointing at it`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const release = {
  version: meta.version,
  minBuiltin: meta.minBuiltin,
  checksum: meta.checksum,
  ...(meta.sessionKey ? { sessionKey: meta.sessionKey } : {}),
};

console.log(`publish: release -> ${JSON.stringify(release, null, 2)}`);
if (dryRun) {
  console.log("publish: --dry-run, nothing written");
  process.exit(0);
}

putKv("release", JSON.stringify(release));
console.log(`publish: ${meta.version} is live`);
