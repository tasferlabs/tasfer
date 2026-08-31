/**
 * `tasfer update` — replace this install with the newest published build.
 *
 * The CLI ships as a release archive per platform: a self-contained `tasfer`
 * executable plus the native modules it loads beside itself (see
 * `.github/workflows/cli-release.yml`). Updating is therefore a download and a
 * directory swap, not a package manager — a self-hoster who curled a tarball
 * onto a box should not have to remember where they got it.
 *
 * The CLI ships at the app's version, into the app's own `v<version>` release
 * — the same one the desktop installers upload into. So the newest release is
 * not necessarily one that carries a `tasfer` build (an app-only release
 * carries none, and a release predating the CLI carries none either), and the
 * question to ask is not "what is newest" but "what is the newest release with
 * a build for this machine".
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { access, constants } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CliError } from "./args";
import { t } from "./messages";
import { isPackaged } from "../host/native";
import { VERSION } from "../version";

const run = promisify(execFile);

const REPO = "tasferlabs/tasfer";
const TAG_PREFIX = "v";
/** Enough to reach past a run of app-only releases without paging. */
const RELEASE_PAGE_SIZE = 30;
/** The CLI's own checksum list, named apart from the app's release assets. */
const CHECKSUMS = "tasfer-checksums.txt";
/** Staging directories live in the install dir; sweep() knows them by this. */
const STAGING_PREFIX = ".update-";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

/** A release that actually carries a build for this platform. */
interface Candidate {
  release: Release;
  version: string;
  asset: ReleaseAsset;
}

/** `0.2.0` sorts above `0.10.0`'s predecessor and below `0.10.0`. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * The archive this machine wants. Matches the names the release workflow
 * builds, so a mismatch here is a missing build rather than a parse error.
 */
function assetName(version: string): string {
  return `tasfer-${version}-${process.platform}-${process.arch}.tar.gz`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `tasfer-cli/${VERSION}`,
    },
  });
  if (!response.ok) {
    throw new CliError("update.checkFailed", { status: response.status });
  }
  return (await response.json()) as T;
}

/**
 * The newest release carrying a build for this machine, or null when none
 * does. Releases without one are skipped rather than reported as an update
 * with a missing asset — from here they are simply not CLI releases.
 */
async function latestRelease(): Promise<Candidate | null> {
  const releases = await fetchJson<Release[]>(
    `https://api.github.com/repos/${REPO}/releases?per_page=${RELEASE_PAGE_SIZE}`,
  );

  let best: Candidate | null = null;
  for (const release of releases) {
    if (!release.tag_name.startsWith(TAG_PREFIX)) continue;
    const version = release.tag_name.slice(TAG_PREFIX.length);
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const asset = release.assets.find((a) => a.name === assetName(version));
    if (!asset) continue;
    if (!best || compareVersions(version, best.version) > 0) {
      best = { release, version, asset };
    }
  }
  return best;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { "user-agent": `tasfer-cli/${VERSION}` },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new CliError("update.downloadFailed", { status: response.status });
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Check the archive against the release's `checksums.txt` before unpacking it.
 * A release without that asset is refused rather than trusted: the whole point
 * of this command is that it runs unattended on a box nobody is watching.
 */
async function verify(
  release: Release,
  archive: Buffer,
  name: string,
): Promise<void> {
  const checksums = release.assets.find((a) => a.name === CHECKSUMS);
  if (!checksums) throw new CliError("update.noChecksums");

  const text = (await download(checksums.browser_download_url)).toString("utf8");
  const line = text
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, file]) => file?.replace(/^\*/, "") === name);
  if (!line) throw new CliError("update.noChecksums");

  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== line[0]) {
    throw new CliError("update.checksumMismatch", {
      expected: line[0],
      actual,
    });
  }
}

/**
 * Swap the extracted build into place.
 *
 * Deleting the running executable would pull the file out from under a process
 * still executing it, but renaming it is safe — the kernel keeps the open inode
 * alive. So every replacement is rename-aside-then-move, and the leftovers go
 * on the next run's cleanup.
 */
function swapIn(installDir: string, staged: string): void {
  /** What has been renamed aside so far, so a failure can put it back. */
  const displaced: [target: string, aside: string][] = [];

  try {
    for (const entry of readdirSync(staged)) {
      const target = join(installDir, entry);
      const aside = `${target}.old`;
      if (existsSync(target)) {
        rmSync(aside, { recursive: true, force: true });
        renameSync(target, aside);
        displaced.push([target, aside]);
      }
      renameSync(join(staged, entry), target);
    }
  } catch (e) {
    // A half-swapped install is worse than no update: the entries already
    // renamed aside are gone from their names, so the next `tasfer` run finds
    // no `node_modules` and the one after that sweeps the only copy away.
    // Undo in reverse and let the caller report the original failure.
    for (const [target, aside] of displaced.reverse()) {
      rmSync(target, { recursive: true, force: true });
      renameSync(aside, target);
    }
    throw e;
  }

  // Only once every entry is in place. Unlinking these can fail while another
  // process still executes them; sweep() collects whatever is left next time.
  for (const [, aside] of displaced) {
    rmSync(aside, { recursive: true, force: true });
  }
}

/**
 * Drop what a previous update could not clean up: `*.old` it could not unlink
 * while they were executing, and staging directories left by a run that died
 * between extract and swap.
 */
function sweep(installDir: string): void {
  for (const entry of readdirSync(installDir)) {
    if (!entry.endsWith(".old") && !entry.startsWith(STAGING_PREFIX)) continue;
    rmSync(join(installDir, entry), { recursive: true, force: true });
  }
}

async function extract(archive: Buffer, name: string, installDir: string): Promise<string> {
  // Inside the install directory, not the system temp dir: `swapIn` moves the
  // build in with rename(), which is same-filesystem only. On a box where /tmp
  // is its own mount — a tmpfs /tmp is the default on most systemd distros —
  // staging there fails the whole update with EXDEV. The install directory is
  // the one place guaranteed to be both writable (checked before we download)
  // and on the same device as the files being replaced.
  const staging = mkdtempSync(join(installDir, STAGING_PREFIX));
  const archivePath = join(staging, name);
  writeFileSync(archivePath, archive);

  await run("tar", ["-xzf", archivePath, "-C", staging]);
  rmSync(archivePath, { force: true });

  // The archive holds one top-level directory named after the build.
  const entries = readdirSync(staging);
  return entries.length === 1 ? join(staging, entries[0]) : staging;
}

export interface UpdateOptions {
  /** Report what is available and exit without touching anything. */
  checkOnly: boolean;
}

export async function updateCli({ checkOnly }: UpdateOptions): Promise<number> {
  console.log(t("update.checking"));

  const newest = await latestRelease();
  if (!newest) {
    console.log(t("update.noReleases"));
    return 0;
  }

  const { release, version, asset } = newest;
  if (compareVersions(version, VERSION) <= 0) {
    console.log(t("update.current", { version: VERSION }));
    return 0;
  }

  console.log(t("update.available", { version, current: VERSION }));
  if (checkOnly) return 0;

  if (!isPackaged()) {
    console.log(t("update.fromSource"));
    return 0;
  }

  const installDir = dirname(process.execPath);
  try {
    await access(installDir, constants.W_OK);
  } catch {
    throw new CliError("update.notWritable", { path: installDir });
  }

  // Before staging, not after: staging directories now live in installDir too,
  // and sweep() cannot tell this run's from an abandoned one.
  sweep(installDir);

  console.log(t("update.downloading", { name: asset.name }));
  const archive = await download(asset.browser_download_url);
  await verify(release, archive, asset.name);

  const staged = await extract(archive, asset.name, installDir);
  try {
    swapIn(installDir, staged);
    chmodSync(join(installDir, basename(process.execPath)), 0o755);
  } finally {
    rmSync(dirname(staged), { recursive: true, force: true });
  }

  console.log(t("update.done", { version }));
  return 0;
}
