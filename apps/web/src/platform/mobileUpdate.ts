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
 *      it is not downloaded again. A bundle that cannot report in does not
 *      open the database either: it waits out the plugin's time limit first,
 *      so a rollback never lands on a bundle that has touched the data.
 *
 * Only web code can travel this way. A change to the Swift/Kotlin side still
 * needs a store release, and `minNativeVersion` in /version.json keeps a
 * bundle away from native apps too old to run it. Such an app is told so: the
 * card and Settings point the person at the App Store or Google Play instead
 * of offering a download.
 *
 * Store updates and bundles together: every release can go out both ways, and
 * the app runs the newer of the two copies it holds. A store update leaves a
 * downloaded bundle in place (`resetWhenUpdate` is off in capacitor.config.js),
 * so a store build that sat in review while a newer bundle went out does not
 * take the app back, and nobody is asked for the same update twice. When the
 * store build's own copy is the newer one, the app moves to it at the next
 * start, before the database is opened (see `confirmBoot`).
 *
 * Older code on newer data: the rollback in step 4 happens before the new
 * bundle has touched the database, and a store update never puts older web
 * code back, so neither causes this. The engine is built for it all the same
 * (it leaves a database written by a newer build alone), as it is for syncing
 * with peers on older builds.
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
/** How long the plugin gets to answer a swap before the page is reloaded. */
const APPLY_TIMEOUT_MS = 5000;
/**
 * The plugin reloads the page itself after a swap. If that reload has not
 * come this long after it answered, the page reloads itself.
 */
const RELOAD_FALLBACK_MS = 5000;
/** The app boots anyway if the plugin has not answered by now. */
const CONFIRM_TIMEOUT_MS = 5000;
/**
 * The same, at the first start of a freshly applied bundle. Longer than the
 * plugin's `appReadyTimeout` (20 s in capacitor.config.js; keep the two in
 * step), so a bundle that could not report in is put back before it opens the
 * database, never after.
 */
const FIRST_START_CONFIRM_TIMEOUT_MS = 25000;
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
  /**
   * Handed to the plugin at this start; cleared once the plugin has heard
   * that it runs. `waited` is set once its first start has had the long wait
   * for that, so a plugin that never answers costs it only once.
   */
  applying?: BundleRef & { waited?: boolean };
  /** Versions that were applied and did not boot. Never tried again. */
  failed?: string[];
  /**
   * The version the plugin last refused to swap in. Refused a second time,
   * with a freshly downloaded copy, it counts as failed.
   */
  refused?: string;
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
  /**
   * The store build whose own copy the app already tried to move to. Kept so
   * a move that does not happen is not tried again at every start.
   */
  storeCopyTried?: string;
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
  /** Goes back to the copy inside the store build. Reloads the page. */
  reset(): Promise<void>;
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
   * Swaps in the waiting bundle. The page reloads into it, so once the plugin
   * has taken the swap (or stops answering) the promise never settles; the
   * page reloads itself if the plugin's reload does not come. It resolves only
   * when the plugin refused the swap, and the caller should then boot the
   * bundle it already has. Never rejects.
   */
  applyPendingBundle(): Promise<void>;
  /**
   * Call once this bundle's code is running, and wait for it before opening
   * the database. Confirms the running bundle to the plugin so it is not
   * rolled back, and records a bundle that was rolled back. After a store
   * update that brought newer web code than the downloaded bundle, it moves
   * to the store build's copy: the page reloads and the promise never
   * settles. Otherwise it always resolves, within a few seconds at worst;
   * at the first start of a freshly applied bundle that the plugin cannot be
   * told about, after the plugin's own rollback time limit has passed.
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

/** A promise did not settle in time (as opposed to rejecting). */
class TimeoutError extends Error {
  constructor() {
    super("timed out");
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
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
    reset: () => plugin.reset(),
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

    let plugin: UpdaterPlugin;
    try {
      plugin = await deps.loadPlugin();
    } catch (error) {
      // Nothing was handed over, and the bundle is not to blame.
      deps.log(`could not apply ${pending.version}`, error);
      writeState({ ...readState(), applying: undefined });
      return;
    }

    // `set` reloads the page into the new bundle. It can answer before that
    // reload comes, and from then on this code must not open the database, so
    // it only waits for the reload (and reloads itself if it never comes). An
    // answer that never comes is treated the same way: the swap may be under
    // way. Whichever bundle the reload brings up then settles it through
    // `applying` (see `confirmBoot`). A rejection means the plugin refused
    // before touching anything, and this code boots as it is.
    deps.log(`applying ${pending.version}`);
    try {
      await withTimeout(plugin.set({ id: pending.id }), APPLY_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        deps.log(`the plugin refused ${pending.version}`, error);
        await forgetRefused(plugin, pending);
        return;
      }
      deps.log(`no answer to the swap to ${pending.version}; reloading`);
      return reloadSoon(0);
    }
    return reloadSoon(RELOAD_FALLBACK_MS);
  }

  /**
   * The plugin has taken a swap and is about to reload the page. Never
   * settles, so the code that waits on it never goes on to open the database.
   * Reloads the page itself after `ms` in case the plugin's reload never
   * comes; the next start sorts out which bundle came up.
   */
  function reloadSoon(ms: number): Promise<never> {
    setTimeout(() => deps.reload(), ms);
    return new Promise<never>(() => {});
  }

  /**
   * The plugin refused to swap in `bundle`. Its copy is deleted, so the next
   * download fetches a fresh one instead of handing the plugin the same copy
   * again. Refused a second time, the version counts as failed: by then a
   * fresh copy was refused too.
   */
  async function forgetRefused(
    plugin: UpdaterPlugin,
    bundle: BundleRef,
  ): Promise<void> {
    await plugin.delete({ id: bundle.id }).catch(() => {});
    const state = { ...readState(), applying: undefined };
    writeState(
      state.refused === bundle.version
        ? withFailed({ ...state, refused: undefined }, bundle.version)
        : { ...state, refused: bundle.version },
    );
  }

  async function confirmBoot(): Promise<void> {
    const state = readState();
    const applying = state.applying;
    // This bundle was swapped in at this start. `applying` stays until the
    // plugin has heard that it runs: should the plugin put the previous
    // bundle back first, that code then finds the record and blames this
    // version. The first time, the wait outlasts the plugin's own time limit,
    // so that a rollback, if it comes, comes before the database is opened.
    const startedHere = applying?.version === deps.runningVersion;
    const longWait = startedHere && !applying?.waited;
    if (applying && !startedHere) {
      // The bundle was swapped in but this older code booted: the plugin
      // rolled it back. Its files may linger in the service worker.
      deps.log(`${applying.version} did not boot, staying on ${deps.runningVersion}`);
      writeState(
        withFailed({ ...state, applying: undefined }, applying.version),
      );
      await deps.dropShellCaches().catch(() => {});
      refresh();
    } else if (longWait) {
      writeState({ ...state, applying: { ...applying, waited: true } });
    }

    /** A move to the store build's copy has started. */
    let moving = false;
    /** The wait below is over and the caller goes on to open the database. */
    let booted = false;
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
      // different one is active, stay silent and let it roll back. At a
      // bundle's first start that rollback is due shortly, so wait for it
      // rather than open the database.
      if (bundle.id !== "builtin" && bundle.version !== deps.runningVersion) {
        deps.log(
          `plugin reports ${bundle.version} but ${deps.runningVersion} is running; not confirming`,
        );
        if (longWait) await new Promise<never>(() => {});
        return;
      }
      await plugin.notifyAppReady();
      if (startedHere) {
        deps.log(`now running ${deps.runningVersion}`);
        const after = readState();
        writeState({
          ...after,
          applying: undefined,
          refused:
            after.refused === deps.runningVersion ? undefined : after.refused,
        });
      }
      if (!deps.enabled) return;
      if (bundle.id === "builtin") {
        // Not waited for: the app should not boot later because of it.
        void deleteLeftovers(plugin).catch(() => {});
        return;
      }
      // Too late: this code has booted, and a move now would reload the page
      // under it.
      if (booted) return;
      await moveToStoreCopy(plugin, native, () => {
        moving = true;
      });
    };
    // The app waits for this before it opens the database, so it must always
    // come back, plugin or no plugin: with this code booted, or with a reload.
    const task = confirm();
    try {
      await withTimeout(
        task,
        longWait ? FIRST_START_CONFIRM_TIMEOUT_MS : CONFIRM_TIMEOUT_MS,
      );
    } catch (error) {
      deps.log("could not confirm boot", error);
      // A move is under way. It ends in a reload, or in a refusal that lets
      // this code boot; either comes within a few seconds.
      if (moving) await task.catch(() => {});
    }
    booted = true;
  }

  /**
   * A downloaded bundle is running. If a store update has since brought newer
   * web code inside the store build, go back to that copy: the native app's
   * version is also the version of the web code it shipped with. The page
   * reloads into it, so on success this never returns. Tried once per store
   * build, so a move that does not happen cannot slow down every start.
   * `onMove` is called once the move is handed to the plugin.
   */
  async function moveToStoreCopy(
    plugin: UpdaterPlugin,
    native: string,
    onMove: () => void,
  ): Promise<void> {
    if (
      !SEMVER.test(native) ||
      compareVersions(native, deps.runningVersion) <= 0
    )
      return;
    const state = readState();
    if (state.storeCopyTried === native) return;
    writeState({ ...state, storeCopyTried: native });
    deps.log(
      `the store build has ${native}, newer than ${deps.runningVersion}; moving to it`,
    );
    onMove();
    await deps.dropShellCaches().catch(() => {});
    // The plugin answers before the page has reloaded. From then on, and when
    // it does not answer at all, this older code only waits for the reload,
    // so it never opens the database with the move under way. If the reload
    // brings this bundle back, `storeCopyTried` keeps it from trying again.
    try {
      await withTimeout(plugin.reset(), APPLY_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        deps.log(`could not move to the store build's ${native}`, error);
        return;
      }
      deps.log(`no answer to the move to ${native}; reloading`);
      await reloadSoon(0);
    }
    await reloadSoon(RELOAD_FALLBACK_MS);
  }

  /**
   * The store build's own copy is running. Deletes downloaded bundles it has
   * caught up with: the plugin keeps them across a store update, and nothing
   * will run them again.
   */
  async function deleteLeftovers(plugin: UpdaterPlugin): Promise<void> {
    const waiting = usablePending(readState())?.id;
    const { bundles } = await plugin.list();
    for (const bundle of bundles) {
      if (bundle.id === "builtin" || bundle.id === waiting) continue;
      if (
        !SEMVER.test(bundle.version) ||
        compareVersions(bundle.version, deps.runningVersion) > 0
      )
        continue;
      deps.log(`deleting leftover bundle ${bundle.version}`);
      await plugin.delete({ id: bundle.id }).catch(() => {});
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
