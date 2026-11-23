/**
 * Over-the-air updates for the iOS and Android apps.
 *
 * The store build ships with a copy of the web app inside it. This module lets
 * an installed app replace that copy with a newer one it downloads itself, so
 * a web-only fix reaches phones without a store release.
 *
 * How one update travels:
 *   1. The Release workflow publishes a zip of the web build and a small
 *      manifest (version, checksum, oldest native app it runs on) to the
 *      `mobile-bundle` GitHub release. See scripts/release/mobile-bundle.mjs.
 *   2. A running app reads the manifest after boot and when it comes back to
 *      the foreground, at most once an hour. A newer bundle is only offered:
 *      the sidebar shows a card, and nothing is downloaded until the person
 *      taps "Update now". With "Update automatically" switched on in Settings
 *      the bundle is downloaded right away instead, without asking. Either
 *      way the native plugin checks the zip against the checksum.
 *   3. The bundle is swapped in at a fresh start, before the database is
 *      opened: the next time the app is opened, or at once when the person
 *      taps "Restart now", which reloads the page the way a language change
 *      does. Never under a running session: nobody loses what they were
 *      typing, and the swap cannot race the save that runs when the app is
 *      backgrounded.
 *   4. As soon as its code runs, and before it opens the database, the new
 *      bundle reports in (`notifyAppReady`). If that never happens the plugin
 *      puts the previous bundle back, and this module remembers the version so
 *      it is not downloaded again.
 *
 * Only web code can travel this way. A change to the Swift/Kotlin side still
 * needs a store release, and `minNativeVersion` in /version.json keeps a
 * bundle away from native apps too old to run it. Such an app is told so: the
 * card and Settings point the person at the App Store or Google Play instead
 * of offering a download.
 *
 * Older code on newer data: the rollback in step 4 happens before the new
 * bundle has touched the database, so it never causes this. One case does. A
 * store update makes the plugin drop downloaded bundles and run the copy
 * inside the new store build. If that build was already in review when a
 * newer bundle went out, the app runs the older copy for one session, until
 * it has downloaded the bundle again. The engine is built for that (it leaves
 * a database written by a newer build alone), as it is for syncing with peers
 * on older builds.
 */

import { APP_VERSION } from "@/version";

/** Where the published manifest lives; the bundle zip sits next to it. */
const DEFAULT_MANIFEST_URL =
  "https://github.com/tasferlabs/tasfer/releases/download/mobile-bundle/mobile-bundle.json";

const STORAGE_KEY = "tasfer.mobileUpdate";

/** Least time between two manifest reads. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Wait this long after a failed download before trying that bundle again. */
const DOWNLOAD_RETRY_MS = 6 * 60 * 60 * 1000;
/** The first check waits for the app to settle after boot. */
const FIRST_CHECK_DELAY_MS = 5000;
/** If the swap has not reloaded the page by now, boot what we have. */
const APPLY_TIMEOUT_MS = 5000;
/** The app boots anyway if the plugin has not answered by now. */
const CONFIRM_TIMEOUT_MS = 5000;
/** Remember this many failed versions; older ones are superseded anyway. */
const MAX_FAILED_VERSIONS = 10;

/** The published description of the newest bundle. */
export interface BundleManifest {
  /** Version of the web app inside the zip (`appVersion` of that build). */
  version: string;
  /** Oldest native app version that can run this bundle. */
  minNativeVersion: string;
  /** File name of the zip, in the same folder as the manifest. */
  file: string;
  /** SHA-256 of the zip, lowercase hex. */
  sha256: string;
}

interface BundleRef {
  id: string;
  version: string;
}

/** What survives between launches, kept in localStorage. */
interface UpdateState {
  /** Downloaded and waiting for the next fresh start. */
  pending?: BundleRef;
  /** Handed to the plugin at this start; cleared once it has booted. */
  applying?: BundleRef;
  /** Versions that were applied and did not boot. Never tried again. */
  failed?: string[];
  /** When the manifest was last read. */
  lastCheck?: number;
  /** No automatic download attempts before this time. */
  retryAfter?: number;
  /** "Update automatically" is on: download without asking. Off when absent. */
  auto?: boolean;
  /** The newer bundle that was found and is not downloaded yet. */
  offered?: BundleManifest;
  /** The published bundle this store build is too old to run. */
  needsStore?: StoreGate;
}

/** A bundle that only a newer store build can run. */
interface StoreGate {
  version: string;
  minNativeVersion: string;
}

/** Where an update stands, as the update card shows it. */
export type MobileUpdateStatus =
  | { phase: "idle" }
  /** A newer bundle is published. Nothing has been downloaded. */
  | { phase: "available"; version: string }
  /** `percent` is 1 to 100, or null until the plugin reports real progress. */
  | { phase: "downloading"; version: string; percent: number | null }
  /** Downloaded, and swapped in at the next fresh start. */
  | { phase: "ready"; version: string }
  /** The download did not finish. It can be tried again. */
  | { phase: "failed"; version: string }
  /**
   * A newer bundle is published, but this store build is too old to run it.
   * The way to it is a store update; nothing can be downloaded here.
   */
  | { phase: "store"; version: string };

/**
 * What a check found. "store" means the newer version needs a store update
 * first; "error" means the manifest could not be read.
 */
export type MobileUpdateCheckOutcome =
  | "available"
  | "ready"
  | "store"
  | "up-to-date"
  | "error"
  | "unsupported";

/** The slice of the native updater plugin this module uses. */
export interface UpdaterPlugin {
  notifyAppReady(): Promise<unknown>;
  current(): Promise<{
    bundle: { id: string; version: string };
    native: string;
  }>;
  list(): Promise<{
    bundles: { id: string; version: string; status: string }[];
  }>;
  download(options: {
    url: string;
    version: string;
    checksum: string;
  }): Promise<{ id: string }>;
  set(options: { id: string }): Promise<void>;
  delete(options: { id: string }): Promise<void>;
  /**
   * Reports how far a running download is, 0 to 100. Resolves with a function
   * that stops the reports.
   */
  onDownloadProgress(listener: (percent: number) => void): Promise<() => void>;
}

/** Everything the updater touches outside itself; swapped out in tests. */
export interface MobileUpdaterDeps {
  /** Version of the web code that is running right now. */
  runningVersion: string;
  manifestUrl: string;
  /** False in dev builds: they report in but never download or swap. */
  enabled: boolean;
  storage: Pick<Storage, "getItem" | "setItem">;
  now(): number;
  loadPlugin(): Promise<UpdaterPlugin>;
  /** Reads the manifest; resolves with the parsed JSON or throws. */
  fetchManifest(url: string): Promise<unknown>;
  /** Drops the service worker's copy of the app shell (see below). */
  dropShellCaches(): Promise<void>;
  /** Reloads the page, which gives the app a fresh start. */
  reload(): void;
  log(message: string, detail?: unknown): void;
}

export interface MobileUpdater {
  /** Whether a downloaded bundle is waiting to be swapped in at this start. */
  hasPendingBundle(): boolean;
  /**
   * Swaps in the waiting bundle. The page reloads into it, so on success the
   * promise never settles. It resolves only when the swap did not happen, and
   * the caller should then boot the bundle it already has. Never rejects.
   */
  applyPendingBundle(): Promise<void>;
  /**
   * Call once this bundle's code is running, and wait for it before opening
   * the database. Confirms the running bundle to the plugin so it is not
   * rolled back, and records a bundle that was rolled back. Always resolves,
   * within a few seconds at worst.
   */
  confirmBoot(): Promise<void>;
  /**
   * Reads the manifest, unless it was read in the last hour, and offers a
   * newer bundle. Downloads it too when "Update automatically" is on. A
   * bundle this store build is too old for is not offered: the status turns
   * to "store" instead. Pass
   * `force` for a check the person asked for: it skips the hourly limit.
   */
  checkForUpdate(options?: {
    force?: boolean;
  }): Promise<MobileUpdateCheckOutcome>;
  /** Downloads the offered bundle. This is the "Update now" tap. */
  downloadUpdate(): Promise<void>;
  /**
   * Restarts into the downloaded bundle: reloads the page, and the swap then
   * happens on the way back up, before the database is opened. Does nothing
   * when no bundle is waiting.
   */
  restartToUpdate(): void;
  /** Where the update stands now. The same object until something changes. */
  getStatus(): MobileUpdateStatus;
  /** Whether new bundles are downloaded without asking. Off by default. */
  getAutoUpdate(): boolean;
  /** Turning it on also downloads a bundle that is already on offer. */
  setAutoUpdate(on: boolean): void;
  /** Calls `listener` when the status or the automatic setting changes. */
  subscribe(listener: () => void): () => void;
  /** Starts the background checks. Returns a function that stops them. */
  start(): () => void;
}

/** Compares two `major.minor.patch` versions: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A bare file name: no folders, no scheme, so it cannot point elsewhere. */
const ZIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/;

/** Validates a manifest read off the network. Null for anything malformed. */
export function parseManifest(raw: unknown): BundleManifest | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const { version, minNativeVersion, file, sha256 } = value as Record<
    string,
    unknown
  >;
  if (typeof version !== "string" || !SEMVER.test(version)) return null;
  if (typeof minNativeVersion !== "string" || !SEMVER.test(minNativeVersion))
    return null;
  if (typeof file !== "string" || !ZIP_NAME.test(file)) return null;
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
  return { version, minNativeVersion, file, sha256 };
}

export type UpdateDecision =
  | { action: "download" }
  | {
      action: "skip";
      reason:
        | "not-newer"
        | "native-too-old"
        | "failed-before"
        | "already-downloaded";
    };

/** Decides whether the published bundle should be downloaded. */
export function decideUpdate(input: {
  manifest: BundleManifest;
  /** Version of the web code running now. */
  runningVersion: string;
  /** Version of the native app (the store build). */
  nativeVersion: string;
  failedVersions: readonly string[];
  pendingVersion: string | undefined;
}): UpdateDecision {
  const { manifest } = input;
  if (compareVersions(manifest.version, input.runningVersion) <= 0) {
    return { action: "skip", reason: "not-newer" };
  }
  // A native version the plugin could not report as a plain semver is treated
  // as too old: better to wait for a store update than to guess.
  if (
    !SEMVER.test(input.nativeVersion) ||
    compareVersions(input.nativeVersion, manifest.minNativeVersion) < 0
  ) {
    return { action: "skip", reason: "native-too-old" };
  }
  if (input.failedVersions.includes(manifest.version)) {
    return { action: "skip", reason: "failed-before" };
  }
  if (input.pendingVersion === manifest.version) {
    return { action: "skip", reason: "already-downloaded" };
  }
  return { action: "download" };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The service worker also runs inside the native app and keeps its own copy of
 * the app's files. Left alone it would hand the old copy of files whose names
 * do not change between builds (the SQLite wasm, the locale files) to the new
 * bundle's code. Dropping those caches makes it read from the bundle on disk;
 * it rebuilds them from there afterwards. Caches that hold downloads worth
 * keeping (spelling dictionaries, the HEIC decoder) are left alone.
 */
async function dropServiceWorkerShellCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter(
        (name) =>
          name.startsWith("workbox-precache") || name === "offline-fallback",
      )
      .map((name) => caches.delete(name)),
  );
}

/**
 * Reads the manifest through the native HTTP client. A plain `fetch` cannot:
 * GitHub's release downloads send no CORS headers.
 */
async function fetchManifestNatively(url: string): Promise<unknown> {
  const { CapacitorHttp } = await import("@capacitor/core");
  const response = await CapacitorHttp.get({
    url,
    responseType: "json",
    connectTimeout: 15000,
    readTimeout: 15000,
  });
  if (response.status !== 200) {
    throw new Error(`manifest request answered ${response.status}`);
  }
  return response.data;
}

/** Stands in where there is no localStorage; nothing is remembered. */
const NO_STORAGE: MobileUpdaterDeps["storage"] = {
  getItem: () => null,
  setItem: () => {},
};

/**
 * Loads the native updater plugin, wrapped in a plain object.
 *
 * The wrapping matters. A Capacitor plugin answers every property name with a
 * native call, `then` included, so a promise resolved with the plugin itself
 * treats it as another promise and never settles.
 */
export async function loadUpdaterPlugin(): Promise<UpdaterPlugin> {
  const { CapacitorUpdater: plugin } = await import("@capgo/capacitor-updater");
  return {
    notifyAppReady: () => plugin.notifyAppReady(),
    current: () => plugin.current(),
    list: () => plugin.list(),
    download: (options) => plugin.download(options),
    set: (options) => plugin.set(options),
    delete: (options) => plugin.delete(options),
    onDownloadProgress: async (listener) => {
      const handle = await plugin.addListener("updaterEvent", (event) => {
        if (event.type === "download") listener(event.data.percent);
      });
      return () => void handle.remove();
    },
  };
}

function defaultDeps(): MobileUpdaterDeps {
  return {
    runningVersion: APP_VERSION,
    manifestUrl:
      import.meta.env.VITE_MOBILE_BUNDLE_MANIFEST_URL || DEFAULT_MANIFEST_URL,
    enabled: import.meta.env.PROD,
    storage: typeof window === "undefined" ? NO_STORAGE : window.localStorage,
    now: () => Date.now(),
    loadPlugin: loadUpdaterPlugin,
    fetchManifest: fetchManifestNatively,
    dropShellCaches: dropServiceWorkerShellCaches,
    reload: () => window.location.reload(),
    log: (message, detail) =>
      detail === undefined
        ? console.log(`[MobileUpdate] ${message}`)
        : console.log(`[MobileUpdate] ${message}`, detail),
  };
}

/**
 * Creates the updater for the native app. One per page; `main.tsx` owns it.
 * Pass `overrides` to replace the outside world in tests.
 */
export function createMobileUpdater(
  overrides: Partial<MobileUpdaterDeps> = {},
): MobileUpdater {
  const deps = { ...defaultDeps(), ...overrides };
  let checking = false;
  /** The download that is running right now. */
  let downloading: { version: string; percent: number | null } | undefined;
  /** The version whose download last failed, until it is tried again. */
  let downloadFailed: string | undefined;
  const listeners = new Set<() => void>();

  function readState(): UpdateState {
    try {
      const raw = deps.storage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? (parsed as UpdateState) : {};
    } catch {
      return {};
    }
  }

  function writeState(state: UpdateState): void {
    try {
      deps.storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full or blocked: updates simply behave as if nothing was saved.
    }
  }

  function withFailed(state: UpdateState, version: string): UpdateState {
    const failed = (state.failed ?? []).filter((v) => v !== version);
    failed.push(version);
    return { ...state, failed: failed.slice(-MAX_FAILED_VERSIONS) };
  }

  /** The waiting bundle, if it is still worth applying. */
  function usablePending(state: UpdateState): BundleRef | undefined {
    const pending = state.pending;
    if (!pending) return undefined;
    // A store update may have brought a newer bundle than the one downloaded.
    if (compareVersions(pending.version, deps.runningVersion) <= 0)
      return undefined;
    if ((state.failed ?? []).includes(pending.version)) return undefined;
    return pending;
  }

  /** The bundle on offer, if it is still worth downloading. */
  function usableOffer(state: UpdateState): BundleManifest | undefined {
    const offered = parseManifest(state.offered);
    if (!offered) return undefined;
    if (compareVersions(offered.version, deps.runningVersion) <= 0)
      return undefined;
    if ((state.failed ?? []).includes(offered.version)) return undefined;
    return offered;
  }

  /** The bundle a store update stands in front of, if it is still ahead. */
  function usableStoreGate(state: UpdateState): StoreGate | undefined {
    const gate = state.needsStore;
    if (
      !gate ||
      typeof gate.version !== "string" ||
      !SEMVER.test(gate.version) ||
      typeof gate.minNativeVersion !== "string" ||
      !SEMVER.test(gate.minNativeVersion)
    )
      return undefined;
    // The store update usually brings that version, or a newer one, itself.
    if (compareVersions(gate.version, deps.runningVersion) <= 0)
      return undefined;
    return gate;
  }

  function computeStatus(): MobileUpdateStatus {
    if (!deps.enabled) return { phase: "idle" };
    if (downloading) return { phase: "downloading", ...downloading };
    const state = readState();
    const pending = usablePending(state);
    const offer = usableOffer(state);
    // An offer newer than the bundle already downloaded comes first: taking it
    // replaces that bundle.
    if (
      offer &&
      (!pending || compareVersions(offer.version, pending.version) > 0)
    ) {
      return {
        phase: downloadFailed === offer.version ? "failed" : "available",
        version: offer.version,
      };
    }
    if (pending) return { phase: "ready", version: pending.version };
    // Last: a bundle that is already downloaded can be used right now.
    const gate = usableStoreGate(state);
    if (gate) return { phase: "store", version: gate.version };
    return { phase: "idle" };
  }

  let status = computeStatus();

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  /** Recomputes the status and tells the listeners when it changed. */
  function refresh(): void {
    const next = computeStatus();
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next;
    notify();
  }

  function outcomeOf(current: MobileUpdateStatus): MobileUpdateCheckOutcome {
    if (current.phase === "idle") return "up-to-date";
    if (current.phase === "store") return "store";
    return current.phase === "ready" ? "ready" : "available";
  }

  function hasPendingBundle(): boolean {
    return deps.enabled && usablePending(readState()) !== undefined;
  }

  async function applyPendingBundle(): Promise<void> {
    if (!deps.enabled) return;
    const state = readState();
    const pending = usablePending(state);
    if (!pending) {
      if (state.pending) writeState({ ...state, pending: undefined });
      return;
    }

    // Moved to `applying` before the swap, so a swap that crashes the app is
    // seen as a failure at the next start instead of being tried forever.
    writeState({ ...state, pending: undefined, applying: pending });
    await deps.dropShellCaches().catch(() => {});

    // `set` reloads the page into the new bundle, so on success nothing below
    // runs. A rejection means the plugin refused before touching anything
    // (the bundle is gone, say): forget it and let a later check fetch it
    // again. Still being here after the timeout means the swap went wrong in
    // some way we cannot see, so that version is not tried again.
    let refused = true;
    try {
      const plugin = await deps.loadPlugin();
      deps.log(`applying ${pending.version}`);
      const swap = plugin.set({ id: pending.id });
      refused = false;
      swap.catch(() => {
        refused = true;
      });
      await withTimeout(
        swap.then(() => new Promise<never>(() => {})),
        APPLY_TIMEOUT_MS,
      );
    } catch (error) {
      deps.log(`could not apply ${pending.version}`, error);
    }
    const after = { ...readState(), applying: undefined };
    writeState(refused ? after : withFailed(after, pending.version));
  }

  async function confirmBoot(): Promise<void> {
    let state = readState();
    const applying = state.applying;
    if (applying) {
      if (applying.version === deps.runningVersion) {
        deps.log(`now running ${applying.version}`);
        state = { ...state, applying: undefined };
      } else {
        // The bundle was swapped in but this older code booted: the plugin
        // rolled it back. Its files may linger in the service worker.
        deps.log(`${applying.version} did not boot, staying on ${deps.runningVersion}`);
        state = withFailed({ ...state, applying: undefined }, applying.version);
        await deps.dropShellCaches().catch(() => {});
      }
      writeState(state);
      refresh();
    }

    const confirm = async () => {
      const plugin = await deps.loadPlugin();
      const { bundle, native } = await plugin.current();
      // The store update the person was sent for has been installed: stop
      // pointing at the store, and look for the bundle again without waiting
      // out the hour.
      const gate = readState().needsStore;
      if (
        gate &&
        SEMVER.test(native) &&
        compareVersions(native, gate.minNativeVersion) >= 0
      ) {
        writeState({
          ...readState(),
          needsStore: undefined,
          lastCheck: undefined,
        });
        refresh();
      }
      // Only vouch for the bundle this code came from. If the plugin thinks a
      // different one is active, stay silent and let it roll back.
      if (bundle.id !== "builtin" && bundle.version !== deps.runningVersion) {
        deps.log(
          `plugin reports ${bundle.version} but ${deps.runningVersion} is running; not confirming`,
        );
        return;
      }
      await plugin.notifyAppReady();
    };
    // The app waits for this before it opens the database, so it must always
    // come back, plugin or no plugin.
    try {
      await withTimeout(confirm(), CONFIRM_TIMEOUT_MS);
    } catch (error) {
      deps.log("could not confirm boot", error);
    }
  }

  /**
   * Fetches `manifest`'s bundle and keeps it for the next start. Resolves with
   * whether it is now waiting. Never rejects.
   */
  async function download(
    plugin: UpdaterPlugin,
    manifest: BundleManifest,
  ): Promise<boolean> {
    if (downloading) return false;
    downloading = { version: manifest.version, percent: null };
    downloadFailed = undefined;
    refresh();
    let stopProgress = () => {};
    try {
      const { bundles } = await plugin.list();
      const have = bundles.find(
        (b) =>
          b.version === manifest.version &&
          (b.status === "pending" || b.status === "success"),
      );
      let id: string;
      if (have) {
        id = have.id;
      } else {
        deps.log(`downloading ${manifest.version}`);
        // Progress is a nicety: the download goes ahead without it.
        stopProgress = await plugin
          .onDownloadProgress((percent) => {
            if (!downloading) return;
            // The plugin reports 0 when it starts. On iOS nothing else comes
            // until the whole zip is in (then 70, 90, 100), so a 0 would sit
            // on screen for the entire download. Until there is real progress
            // the card shows a moving bar and no number instead.
            if (!(percent > 0)) return;
            const clamped = Math.min(100, Math.max(0, percent));
            downloading = { ...downloading, percent: clamped };
            refresh();
          })
          .catch(() => () => {});
        const downloaded = await plugin.download({
          url: new URL(manifest.file, deps.manifestUrl).href,
          version: manifest.version,
          checksum: manifest.sha256,
        });
        id = downloaded.id;
      }

      const after = readState();
      const superseded = after.pending;
      writeState({
        ...after,
        pending: { id, version: manifest.version },
        offered: undefined,
        retryAfter: undefined,
      });
      deps.log(`${manifest.version} is ready for the next start`);
      if (superseded && superseded.id !== id) {
        await plugin.delete({ id: superseded.id }).catch(() => {});
      }
      return true;
    } catch (error) {
      deps.log(`download of ${manifest.version} failed`, error);
      downloadFailed = manifest.version;
      return false;
    } finally {
      stopProgress();
      downloading = undefined;
      refresh();
    }
  }

  async function checkForUpdate(
    options: { force?: boolean } = {},
  ): Promise<MobileUpdateCheckOutcome> {
    if (!deps.enabled) return "unsupported";
    if (checking) return outcomeOf(status);
    const before = readState();
    const now = deps.now();
    if (
      !options.force &&
      before.lastCheck !== undefined &&
      now - before.lastCheck < CHECK_INTERVAL_MS
    )
      return outcomeOf(status);

    checking = true;
    try {
      // A failed read (offline, say) is not counted, so the next return to the
      // foreground tries again instead of waiting out the hour.
      const raw = await deps.fetchManifest(deps.manifestUrl);
      writeState({ ...readState(), lastCheck: now });
      const manifest = parseManifest(raw);
      if (!manifest) {
        deps.log("manifest is malformed, ignoring it");
        return "error";
      }

      const plugin = await deps.loadPlugin();
      const { native } = await plugin.current();
      const state = readState();
      const decision = decideUpdate({
        manifest,
        runningVersion: deps.runningVersion,
        nativeVersion: native,
        failedVersions: state.failed ?? [],
        pendingVersion: state.pending?.version,
      });
      if (decision.action === "skip") {
        if (decision.reason !== "not-newer") {
          deps.log(`skipping ${manifest.version}: ${decision.reason}`);
        }
        // Whatever was on offer is not what is published any more. A bundle
        // this store build cannot run is remembered, so the person can be
        // pointed at the store.
        writeState({
          ...state,
          offered: undefined,
          needsStore:
            decision.reason === "native-too-old"
              ? {
                  version: manifest.version,
                  minNativeVersion: manifest.minNativeVersion,
                }
              : undefined,
        });
        refresh();
        return outcomeOf(status);
      }

      // Offered first, so the card is right even when the download below does
      // not happen or does not finish.
      writeState({ ...state, offered: manifest, needsStore: undefined });
      refresh();
      if (!state.auto) return "available";
      // The back-off is for retries nobody asked for.
      if (
        !options.force &&
        state.retryAfter !== undefined &&
        now < state.retryAfter
      )
        return "available";
      if (await download(plugin, manifest)) return "ready";
      writeState({ ...readState(), retryAfter: now + DOWNLOAD_RETRY_MS });
      return "available";
    } catch (error) {
      deps.log("update check failed", error);
      return "error";
    } finally {
      checking = false;
    }
  }

  async function downloadUpdate(): Promise<void> {
    if (!deps.enabled || downloading) return;
    const offer = usableOffer(readState());
    if (!offer) return;
    let plugin: UpdaterPlugin;
    try {
      plugin = await deps.loadPlugin();
    } catch (error) {
      deps.log(`download of ${offer.version} failed`, error);
      downloadFailed = offer.version;
      refresh();
      return;
    }
    await download(plugin, offer);
  }

  function restartToUpdate(): void {
    if (hasPendingBundle()) deps.reload();
  }

  function getAutoUpdate(): boolean {
    return readState().auto === true;
  }

  function setAutoUpdate(on: boolean): void {
    writeState({ ...readState(), auto: on || undefined });
    notify();
    if (on) void downloadUpdate();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }

  function start(): () => void {
    if (!deps.enabled) return () => {};
    const timer = setTimeout(() => void checkForUpdate(), FIRST_CHECK_DELAY_MS);
    const onVisibility = () => {
      if (!document.hidden) void checkForUpdate();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }

  return {
    hasPendingBundle,
    applyPendingBundle,
    confirmBoot,
    checkForUpdate,
    downloadUpdate,
    restartToUpdate,
    getStatus: () => status,
    getAutoUpdate,
    setAutoUpdate,
    subscribe,
    start,
  };
}
