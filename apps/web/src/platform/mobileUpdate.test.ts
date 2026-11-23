import { describe, expect, it, vi } from "vitest";
import {
  compareVersions,
  createMobileUpdater,
  decideUpdate,
  loadUpdaterPlugin,
  parseManifest,
  type BundleManifest,
  type MobileUpdaterDeps,
  type UpdaterPlugin,
} from "./mobileUpdate";

const MANIFEST_URL =
  "https://github.com/tasferlabs/tasfer/releases/download/mobile-bundle/mobile-bundle.json";
const SHA = "a".repeat(64);

function manifest(over: Partial<BundleManifest> = {}): BundleManifest {
  return {
    version: "0.2.0",
    minNativeVersion: "0.1.0",
    file: "tasfer-web-0.2.0.zip",
    sha256: SHA,
    ...over,
  };
}

function memoryStorage(initial?: object) {
  const data = new Map<string, string>();
  if (initial) data.set("tasfer.mobileUpdate", JSON.stringify(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    state: () => JSON.parse(data.get("tasfer.mobileUpdate") ?? "{}"),
  };
}

function fakePlugin(over: Partial<UpdaterPlugin> = {}): UpdaterPlugin {
  return {
    notifyAppReady: vi.fn(async () => ({})),
    current: vi.fn(async () => ({
      bundle: { id: "builtin", version: "builtin" },
      native: "0.1.0",
    })),
    list: vi.fn(async () => ({ bundles: [] })),
    download: vi.fn(async () => ({ id: "bundle-1" })),
    set: vi.fn(() => new Promise<void>(() => {})),
    reset: vi.fn(() => new Promise<void>(() => {})),
    delete: vi.fn(async () => {}),
    onDownloadProgress: vi.fn(async () => () => {}),
    ...over,
  };
}

function setup(over: Partial<MobileUpdaterDeps> & { state?: object } = {}) {
  const { state, ...deps } = over;
  const storage = memoryStorage(state);
  const plugin = fakePlugin();
  const dropShellCaches = vi.fn(async () => {});
  const reload = vi.fn();
  const updater = createMobileUpdater({
    runningVersion: "0.1.0",
    manifestUrl: MANIFEST_URL,
    enabled: true,
    storage,
    now: () => 1_000_000,
    loadPlugin: async () => plugin,
    fetchManifest: async () => manifest(),
    dropShellCaches,
    reload,
    log: () => {},
    ...deps,
  });
  return { updater, storage, plugin, dropShellCaches, reload };
}

describe("loadUpdaterPlugin", () => {
  it("resolves, with an object a promise will not mistake for another promise", async () => {
    // Found on a simulator: resolving a promise with the Capacitor plugin
    // itself hangs, because the plugin answers `then` like any other method.
    const plugin = await loadUpdaterPlugin();
    expect("then" in plugin).toBe(false);
    expect(typeof plugin.notifyAppReady).toBe("function");
  });
});

describe("compareVersions", () => {
  it("orders by major, minor, then patch as numbers", () => {
    expect(compareVersions("0.1.14", "0.1.14")).toBe(0);
    expect(compareVersions("0.1.15", "0.1.14")).toBeGreaterThan(0);
    expect(compareVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });
});

describe("parseManifest", () => {
  it("accepts a well-formed manifest, as an object or as JSON text", () => {
    expect(parseManifest(manifest())).toEqual(manifest());
    expect(parseManifest(JSON.stringify(manifest()))).toEqual(manifest());
  });

  it("rejects anything malformed", () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest("not json")).toBeNull();
    expect(parseManifest(manifest({ version: "0.2" }))).toBeNull();
    expect(parseManifest(manifest({ minNativeVersion: "latest" }))).toBeNull();
    expect(parseManifest(manifest({ sha256: "abc" }))).toBeNull();
  });

  it("rejects a file that is not a bare zip name", () => {
    for (const file of [
      "https://evil.example/bundle.zip",
      "../bundle.zip",
      "folder/bundle.zip",
      "bundle.exe",
    ]) {
      expect(parseManifest(manifest({ file }))).toBeNull();
    }
  });
});

describe("decideUpdate", () => {
  const base = {
    manifest: manifest(),
    runningVersion: "0.1.0",
    nativeVersion: "0.1.0",
    failedVersions: [] as string[],
    pendingVersion: undefined,
  };

  it("downloads a newer bundle the native app can run", () => {
    expect(decideUpdate(base)).toEqual({ action: "download" });
  });

  it("skips a bundle that is not newer than the running code", () => {
    expect(decideUpdate({ ...base, runningVersion: "0.2.0" })).toEqual({
      action: "skip",
      reason: "not-newer",
    });
    expect(decideUpdate({ ...base, runningVersion: "0.3.0" })).toEqual({
      action: "skip",
      reason: "not-newer",
    });
  });

  it("skips a bundle that needs a newer native app", () => {
    const needsNewer = manifest({ minNativeVersion: "0.1.5" });
    expect(decideUpdate({ ...base, manifest: needsNewer })).toEqual({
      action: "skip",
      reason: "native-too-old",
    });
    expect(decideUpdate({ ...base, nativeVersion: "unknown" })).toEqual({
      action: "skip",
      reason: "native-too-old",
    });
  });

  it("skips a version that failed to boot before", () => {
    expect(decideUpdate({ ...base, failedVersions: ["0.2.0"] })).toEqual({
      action: "skip",
      reason: "failed-before",
    });
  });

  it("skips a version that is already downloaded", () => {
    expect(decideUpdate({ ...base, pendingVersion: "0.2.0" })).toEqual({
      action: "skip",
      reason: "already-downloaded",
    });
  });
});

describe("checkForUpdate, asking first", () => {
  it("offers a newer bundle and downloads nothing", async () => {
    const { updater, plugin, storage } = setup();
    expect(await updater.checkForUpdate()).toBe("available");
    expect(plugin.download).not.toHaveBeenCalled();
    expect(updater.getStatus()).toEqual({ phase: "available", version: "0.2.0" });
    expect(storage.state().pending).toBeUndefined();
    expect(updater.hasPendingBundle()).toBe(false);
  });

  it("keeps the offer across a restart", async () => {
    const { updater } = setup({ state: { offered: manifest() } });
    expect(updater.getStatus()).toEqual({ phase: "available", version: "0.2.0" });
  });

  it("drops an offer the app has caught up with", async () => {
    const { updater } = setup({
      runningVersion: "0.2.0",
      state: { offered: manifest() },
    });
    expect(updater.getStatus()).toEqual({ phase: "idle" });
  });

  it("withdraws the offer when the published bundle is no longer newer", async () => {
    const { updater, storage } = setup({
      state: { offered: manifest() },
      fetchManifest: async () => manifest({ version: "0.1.0" }),
    });
    expect(await updater.checkForUpdate()).toBe("up-to-date");
    expect(storage.state().offered).toBeUndefined();
    expect(updater.getStatus()).toEqual({ phase: "idle" });
  });

  it("reports that the manifest could not be read", async () => {
    const { updater } = setup({
      fetchManifest: async () => {
        throw new Error("offline");
      },
    });
    expect(await updater.checkForUpdate()).toBe("error");
  });

  it("skips the hourly limit for a check the person asked for", async () => {
    const fetchManifest = vi.fn(async () => manifest({ version: "0.1.0" }));
    const { updater } = setup({ fetchManifest });
    await updater.checkForUpdate();
    await updater.checkForUpdate();
    expect(fetchManifest).toHaveBeenCalledTimes(1);
    await updater.checkForUpdate({ force: true });
    expect(fetchManifest).toHaveBeenCalledTimes(2);
  });
});

describe("checkForUpdate, a bundle this store build is too old for", () => {
  const needsNewer = async () => manifest({ minNativeVersion: "0.1.5" });

  it("points at the store and offers nothing to download", async () => {
    const { updater, plugin, storage } = setup({ fetchManifest: needsNewer });
    expect(await updater.checkForUpdate()).toBe("store");
    expect(updater.getStatus()).toEqual({ phase: "store", version: "0.2.0" });
    expect(storage.state().offered).toBeUndefined();

    await updater.downloadUpdate();
    expect(plugin.download).not.toHaveBeenCalled();
  });

  it("does the same with automatic updates on", async () => {
    const { updater, plugin } = setup({
      fetchManifest: needsNewer,
      state: { auto: true },
    });
    expect(await updater.checkForUpdate()).toBe("store");
    expect(plugin.download).not.toHaveBeenCalled();
  });

  it("keeps pointing at the store across a restart", () => {
    const { updater } = setup({
      state: { needsStore: { version: "0.2.0", minNativeVersion: "0.1.5" } },
    });
    expect(updater.getStatus()).toEqual({ phase: "store", version: "0.2.0" });
  });

  it("stops once the store update has brought that version", () => {
    const { updater } = setup({
      runningVersion: "0.2.0",
      state: { needsStore: { version: "0.2.0", minNativeVersion: "0.1.5" } },
    });
    expect(updater.getStatus()).toEqual({ phase: "idle" });
  });

  it("offers the bundle once the store build is new enough", async () => {
    const { updater, plugin, storage } = setup({
      fetchManifest: needsNewer,
      state: {
        needsStore: { version: "0.2.0", minNativeVersion: "0.1.5" },
        lastCheck: 999_000,
      },
    });
    vi.mocked(plugin.current).mockResolvedValue({
      bundle: { id: "builtin", version: "builtin" },
      native: "0.1.5",
    });
    // Seen at boot, before the hourly check would come round again.
    await updater.confirmBoot();
    expect(updater.getStatus()).toEqual({ phase: "idle" });
    expect(storage.state().lastCheck).toBeUndefined();

    expect(await updater.checkForUpdate()).toBe("available");
    expect(updater.getStatus()).toEqual({
      phase: "available",
      version: "0.2.0",
    });
  });

  it("forgets the store when the published bundle runs here after all", async () => {
    const { updater, storage } = setup({
      state: { needsStore: { version: "0.2.0", minNativeVersion: "0.1.5" } },
    });
    expect(await updater.checkForUpdate()).toBe("available");
    expect(storage.state().needsStore).toBeUndefined();
  });

  it("shows a bundle that is already downloaded first", () => {
    const { updater } = setup({
      state: {
        pending: { id: "bundle-1", version: "0.1.5" },
        needsStore: { version: "0.2.0", minNativeVersion: "0.1.5" },
      },
    });
    expect(updater.getStatus()).toEqual({ phase: "ready", version: "0.1.5" });
  });
});

describe("downloadUpdate", () => {
  it("downloads the offered bundle and keeps it for the next start", async () => {
    const { updater, plugin, storage } = setup();
    await updater.checkForUpdate();
    await updater.downloadUpdate();
    expect(plugin.download).toHaveBeenCalledWith({
      url: "https://github.com/tasferlabs/tasfer/releases/download/mobile-bundle/tasfer-web-0.2.0.zip",
      version: "0.2.0",
      checksum: SHA,
    });
    expect(storage.state().pending).toEqual({ id: "bundle-1", version: "0.2.0" });
    expect(storage.state().offered).toBeUndefined();
    expect(updater.getStatus()).toEqual({ phase: "ready", version: "0.2.0" });
    // Downloading never swaps the bundle under a running session.
    expect(plugin.set).not.toHaveBeenCalled();
  });

  it("does nothing when no bundle is on offer", async () => {
    const { updater, plugin } = setup();
    await updater.downloadUpdate();
    expect(plugin.download).not.toHaveBeenCalled();
  });

  it("reports progress to its listeners while it downloads", async () => {
    const { updater, plugin } = setup({ state: { offered: manifest() } });
    let report: (percent: number) => void = () => {};
    vi.mocked(plugin.onDownloadProgress).mockImplementation(async (listener) => {
      report = listener;
      return () => {};
    });
    let finish: (value: { id: string }) => void = () => {};
    vi.mocked(plugin.download).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const seen: unknown[] = [];
    updater.subscribe(() => seen.push(updater.getStatus()));

    const done = updater.downloadUpdate();
    await vi.waitFor(() => expect(plugin.download).toHaveBeenCalled());
    // The plugin's opening 0 is not progress: the status stays without a number.
    report(0);
    report(62);
    finish({ id: "bundle-1" });
    await done;

    expect(seen).toEqual([
      { phase: "downloading", version: "0.2.0", percent: null },
      { phase: "downloading", version: "0.2.0", percent: 62 },
      { phase: "ready", version: "0.2.0" },
    ]);
  });

  it("shows a failed download and lets it be tried again at once", async () => {
    const { updater, plugin, storage } = setup({
      state: { offered: manifest() },
    });
    vi.mocked(plugin.download).mockRejectedValueOnce(new Error("offline"));
    await updater.downloadUpdate();
    expect(updater.getStatus()).toEqual({ phase: "failed", version: "0.2.0" });
    // No back-off: the person is the one asking.
    expect(storage.state().retryAfter).toBeUndefined();

    await updater.downloadUpdate();
    expect(updater.getStatus()).toEqual({ phase: "ready", version: "0.2.0" });
  });

  it("still downloads when progress cannot be watched", async () => {
    const { updater, plugin } = setup({ state: { offered: manifest() } });
    vi.mocked(plugin.onDownloadProgress).mockRejectedValue(new Error("no"));
    await updater.downloadUpdate();
    expect(updater.getStatus()).toEqual({ phase: "ready", version: "0.2.0" });
  });
});

describe("restartToUpdate", () => {
  it("reloads the page when a bundle is waiting", () => {
    const { updater, reload } = setup({
      state: { pending: { id: "bundle-1", version: "0.2.0" } },
    });
    expect(updater.getStatus()).toEqual({ phase: "ready", version: "0.2.0" });
    updater.restartToUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no bundle is waiting", () => {
    const { updater, reload } = setup();
    updater.restartToUpdate();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("setAutoUpdate", () => {
  it("is off until switched on, and remembers the choice", () => {
    const { updater, storage } = setup();
    expect(updater.getAutoUpdate()).toBe(false);
    const listener = vi.fn();
    updater.subscribe(listener);
    updater.setAutoUpdate(true);
    expect(updater.getAutoUpdate()).toBe(true);
    expect(storage.state().auto).toBe(true);
    expect(listener).toHaveBeenCalled();
    updater.setAutoUpdate(false);
    expect(updater.getAutoUpdate()).toBe(false);
  });

  it("downloads a bundle that is already on offer when switched on", async () => {
    const { updater, plugin } = setup({ state: { offered: manifest() } });
    updater.setAutoUpdate(true);
    await vi.waitFor(() =>
      expect(updater.getStatus()).toEqual({ phase: "ready", version: "0.2.0" }),
    );
    expect(plugin.download).toHaveBeenCalledTimes(1);
  });
});

describe("checkForUpdate, updating automatically", () => {
  it("downloads the bundle next to the manifest and keeps it for the next start", async () => {
    const { updater, plugin, storage } = setup({ state: { auto: true } });
    expect(await updater.checkForUpdate()).toBe("ready");
    expect(plugin.download).toHaveBeenCalledWith({
      url: "https://github.com/tasferlabs/tasfer/releases/download/mobile-bundle/tasfer-web-0.2.0.zip",
      version: "0.2.0",
      checksum: SHA,
    });
    expect(storage.state().pending).toEqual({ id: "bundle-1", version: "0.2.0" });
    expect(updater.hasPendingBundle()).toBe(true);
    // Downloading never swaps the bundle under a running session.
    expect(plugin.set).not.toHaveBeenCalled();
  });

  it("reads the manifest at most once an hour", async () => {
    const fetchManifest = vi.fn(async () => manifest({ version: "0.1.0" }));
    let now = 1_000_000;
    const { updater } = setup({
      fetchManifest,
      now: () => now,
      state: { auto: true },
    });
    await updater.checkForUpdate();
    now += 59 * 60 * 1000;
    await updater.checkForUpdate();
    expect(fetchManifest).toHaveBeenCalledTimes(1);
    now += 2 * 60 * 1000;
    await updater.checkForUpdate();
    expect(fetchManifest).toHaveBeenCalledTimes(2);
  });

  it("tries again right away after a manifest read that failed", async () => {
    const fetchManifest = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(manifest());
    const { updater, plugin } = setup({ fetchManifest, state: { auto: true } });
    await updater.checkForUpdate();
    expect(plugin.download).not.toHaveBeenCalled();
    await updater.checkForUpdate();
    expect(plugin.download).toHaveBeenCalledTimes(1);
  });

  it("backs off for six hours after a failed download", async () => {
    let now = 1_000_000;
    const { updater, plugin, storage } = setup({
      now: () => now,
      state: { auto: true },
    });
    vi.mocked(plugin.download).mockRejectedValueOnce(new Error("bad checksum"));
    await updater.checkForUpdate();
    expect(storage.state().pending).toBeUndefined();

    now += 2 * 60 * 60 * 1000;
    await updater.checkForUpdate();
    expect(plugin.download).toHaveBeenCalledTimes(1);

    now += 5 * 60 * 60 * 1000;
    await updater.checkForUpdate();
    expect(plugin.download).toHaveBeenCalledTimes(2);
    expect(storage.state().pending).toEqual({ id: "bundle-1", version: "0.2.0" });
  });

  it("reuses a bundle the plugin already holds", async () => {
    const { updater, plugin, storage } = setup({ state: { auto: true } });
    vi.mocked(plugin.list).mockResolvedValue({
      bundles: [{ id: "kept", version: "0.2.0", status: "pending" }],
    });
    await updater.checkForUpdate();
    expect(plugin.download).not.toHaveBeenCalled();
    expect(storage.state().pending).toEqual({ id: "kept", version: "0.2.0" });
  });

  it("deletes a waiting bundle that a newer one replaces", async () => {
    const { updater, plugin, storage } = setup({
      state: { auto: true, pending: { id: "old", version: "0.1.5" } },
    });
    await updater.checkForUpdate();
    expect(storage.state().pending).toEqual({ id: "bundle-1", version: "0.2.0" });
    expect(plugin.delete).toHaveBeenCalledWith({ id: "old" });
  });

  it("does nothing in a dev build", async () => {
    const fetchManifest = vi.fn(async () => manifest());
    const { updater } = setup({
      enabled: false,
      fetchManifest,
      state: { auto: true, offered: manifest() },
    });
    expect(await updater.checkForUpdate()).toBe("unsupported");
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(updater.getStatus()).toEqual({ phase: "idle" });
  });
});

describe("applyPendingBundle", () => {
  it("hands the waiting bundle to the plugin and does not settle while it reloads", async () => {
    const { updater, plugin, storage, dropShellCaches } = setup({
      state: { pending: { id: "bundle-1", version: "0.2.0" } },
    });
    let settled = false;
    void updater.applyPendingBundle().then(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(plugin.set).toHaveBeenCalledWith({ id: "bundle-1" }),
    );
    expect(settled).toBe(false);
    expect(dropShellCaches).toHaveBeenCalled();
    // Recorded before the swap, so a crash here is noticed at the next start.
    expect(storage.state().applying).toEqual({ id: "bundle-1", version: "0.2.0" });
    expect(storage.state().pending).toBeUndefined();
  });

  it("forgets the bundle, without blaming the version, when the plugin refuses it", async () => {
    const { updater, plugin, storage } = setup({
      state: { pending: { id: "gone", version: "0.2.0" } },
    });
    vi.mocked(plugin.set).mockRejectedValue(new Error("id gone doesn't exist"));
    await updater.applyPendingBundle();
    expect(storage.state().applying).toBeUndefined();
    expect(storage.state().failed ?? []).toEqual([]);
    expect(updater.hasPendingBundle()).toBe(false);
    // Its copy goes, so the next download fetches a fresh one.
    expect(plugin.delete).toHaveBeenCalledWith({ id: "gone" });
  });

  it("downloads a fresh copy after a refusal instead of reusing the refused one", async () => {
    const { updater, plugin } = setup({
      state: { pending: { id: "bundle-1", version: "0.2.0" } },
    });
    vi.mocked(plugin.set).mockRejectedValue(new Error("refused"));
    await updater.applyPendingBundle();
    // The plugin now lists the copy as deleted.
    vi.mocked(plugin.list).mockResolvedValue({
      bundles: [{ id: "bundle-1", version: "0.2.0", status: "deleted" }],
    });
    await updater.checkForUpdate({ force: true });
    await updater.downloadUpdate();
    expect(plugin.download).toHaveBeenCalledTimes(1);
  });

  it("gives up on a version the plugin refuses a second time", async () => {
    const { updater, plugin, storage } = setup({
      state: {
        pending: { id: "bundle-2", version: "0.2.0" },
        refused: "0.2.0",
      },
    });
    vi.mocked(plugin.set).mockRejectedValue(new Error("refused"));
    await updater.applyPendingBundle();
    expect(storage.state().failed).toEqual(["0.2.0"]);
    expect(storage.state().refused).toBeUndefined();

    await updater.checkForUpdate({ force: true });
    expect(updater.getStatus()).toEqual({ phase: "idle" });
  });

  it("does not blame the version when the plugin cannot be loaded", async () => {
    const { updater, storage } = setup({
      state: { pending: { id: "bundle-1", version: "0.2.0" } },
      loadPlugin: async () => {
        throw new Error("no plugin");
      },
    });
    await updater.applyPendingBundle();
    expect(storage.state().applying).toBeUndefined();
    expect(storage.state().failed ?? []).toEqual([]);
    expect(storage.state().refused).toBeUndefined();
  });

  it("reloads the page itself when the plugin takes the swap but does not reload", async () => {
    vi.useFakeTimers();
    try {
      const { updater, plugin, storage, reload } = setup({
        state: { pending: { id: "bundle-1", version: "0.2.0" } },
      });
      vi.mocked(plugin.set).mockResolvedValue();
      let settled = false;
      void updater.applyPendingBundle().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4000);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      expect(reload).toHaveBeenCalledTimes(1);
      // Never boots the old code: the database stays closed until the reload.
      expect(settled).toBe(false);
      // The start after the reload settles it, whichever bundle comes up.
      expect(storage.state().applying).toEqual({ id: "bundle-1", version: "0.2.0" });
      expect(storage.state().failed ?? []).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads the page when the plugin never answers the swap", async () => {
    vi.useFakeTimers();
    try {
      const { updater, reload } = setup({
        state: { pending: { id: "bundle-1", version: "0.2.0" } },
      });
      let settled = false;
      void updater.applyPendingBundle().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(5100);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a waiting bundle that a store update has caught up with", async () => {
    const { updater, plugin, storage } = setup({
      runningVersion: "0.2.0",
      state: { pending: { id: "bundle-1", version: "0.2.0" } },
    });
    expect(updater.hasPendingBundle()).toBe(false);
    await updater.applyPendingBundle();
    expect(plugin.set).not.toHaveBeenCalled();
    expect(storage.state().pending).toBeUndefined();
  });
});

describe("confirmBoot", () => {
  it("confirms the built-in bundle", async () => {
    const { updater, plugin } = setup();
    await updater.confirmBoot();
    expect(plugin.notifyAppReady).toHaveBeenCalledTimes(1);
  });

  it("confirms a freshly applied bundle that booted", async () => {
    const { updater, plugin, storage } = setup({
      runningVersion: "0.2.0",
      state: { applying: { id: "bundle-1", version: "0.2.0" } },
    });
    vi.mocked(plugin.current).mockResolvedValue({
      bundle: { id: "bundle-1", version: "0.2.0" },
      native: "0.1.0",
    });
    await updater.confirmBoot();
    expect(plugin.notifyAppReady).toHaveBeenCalledTimes(1);
    expect(storage.state().applying).toBeUndefined();
    expect(storage.state().failed ?? []).toEqual([]);
  });

  it("remembers a bundle that was rolled back and never downloads it again", async () => {
    const { updater, plugin, storage, dropShellCaches } = setup({
      state: { applying: { id: "bundle-1", version: "0.2.0" } },
    });
    await updater.confirmBoot();
    expect(storage.state().failed).toEqual(["0.2.0"]);
    expect(dropShellCaches).toHaveBeenCalled();
    // The older bundle that is running again is still confirmed.
    expect(plugin.notifyAppReady).toHaveBeenCalledTimes(1);

    await updater.checkForUpdate();
    expect(plugin.download).not.toHaveBeenCalled();
  });

  it("still resolves when the plugin never answers, so the app can boot", async () => {
    vi.useFakeTimers();
    try {
      const { updater, plugin } = setup();
      vi.mocked(plugin.current).mockReturnValue(new Promise(() => {}));
      let resolved = false;
      void updater.confirmBoot().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(6000);
      expect(resolved).toBe(true);
      expect(plugin.notifyAppReady).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not vouch for a bundle other than the one that is running", async () => {
    const { updater, plugin } = setup();
    vi.mocked(plugin.current).mockResolvedValue({
      bundle: { id: "bundle-1", version: "0.2.0" },
      native: "0.1.0",
    });
    await updater.confirmBoot();
    expect(plugin.notifyAppReady).not.toHaveBeenCalled();
  });
});

describe("confirmBoot, at a freshly applied bundle's first start", () => {
  function firstStart(applying: object = { id: "bundle-1", version: "0.2.0" }) {
    const ctx = setup({ runningVersion: "0.2.0", state: { applying } });
    vi.mocked(ctx.plugin.current).mockResolvedValue({
      bundle: { id: "bundle-1", version: "0.2.0" },
      native: "0.1.0",
    });
    return ctx;
  }

  it("keeps the record until the plugin has heard that the bundle runs", async () => {
    const { updater, plugin, storage } = firstStart();
    vi.mocked(plugin.notifyAppReady).mockRejectedValue(new Error("no bridge"));
    await updater.confirmBoot();
    // If the plugin now puts the previous bundle back, that code finds this
    // record and blames 0.2.0, so it is not downloaded again.
    expect(storage.state().applying).toMatchObject({ version: "0.2.0" });
  });

  it("clears an earlier refusal once the version runs", async () => {
    const { updater, storage } = setup({
      runningVersion: "0.2.0",
      state: { applying: { id: "bundle-1", version: "0.2.0" }, refused: "0.2.0" },
    });
    await updater.confirmBoot();
    expect(storage.state().refused).toBeUndefined();
  });

  it("keeps the database closed past the plugin's rollback time when it cannot be told", async () => {
    vi.useFakeTimers();
    try {
      const { updater, plugin } = firstStart();
      vi.mocked(plugin.current).mockReturnValue(new Promise(() => {}));
      let resolved = false;
      void updater.confirmBoot().then(() => {
        resolved = true;
      });
      // The plugin's appReadyTimeout is 20 s: a rollback would come by then.
      await vi.advanceTimersByTimeAsync(21_000);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the rollback when the plugin reports another bundle", async () => {
    vi.useFakeTimers();
    try {
      const { updater, plugin } = firstStart();
      vi.mocked(plugin.current).mockResolvedValue({
        bundle: { id: "bundle-0", version: "0.1.5" },
        native: "0.1.0",
      });
      let resolved = false;
      void updater.confirmBoot().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(21_000);
      expect(resolved).toBe(false);
      expect(plugin.notifyAppReady).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits that long only once, so a plugin that never answers is not paid for at every start", async () => {
    vi.useFakeTimers();
    try {
      const { updater, plugin, storage } = firstStart();
      vi.mocked(plugin.current).mockReturnValue(new Promise(() => {}));
      void updater.confirmBoot();
      expect(storage.state().applying).toMatchObject({ waited: true });

      const again = firstStart(storage.state().applying);
      vi.mocked(again.plugin.current).mockReturnValue(new Promise(() => {}));
      let resolved = false;
      void again.updater.confirmBoot().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("confirmBoot, after a store update", () => {
  /** A downloaded bundle is running inside a store build of `native`. */
  function onBundle(running: string, native: string, state?: object) {
    const ctx = setup({ runningVersion: running, state });
    vi.mocked(ctx.plugin.current).mockResolvedValue({
      bundle: { id: "bundle-1", version: running },
      native,
    });
    return ctx;
  }

  it("keeps a downloaded bundle that is newer than the store build", async () => {
    // The store build sat in review while a newer bundle went out.
    const { updater, plugin, storage } = onBundle("0.3.0", "0.2.0");
    await updater.confirmBoot();
    expect(plugin.notifyAppReady).toHaveBeenCalledTimes(1);
    expect(plugin.reset).not.toHaveBeenCalled();
    expect(plugin.delete).not.toHaveBeenCalled();
    expect(storage.state().storeCopyTried).toBeUndefined();
  });

  it("keeps a downloaded bundle the store build has only caught up with", async () => {
    const { updater, plugin } = onBundle("0.2.0", "0.2.0");
    await updater.confirmBoot();
    expect(plugin.reset).not.toHaveBeenCalled();
  });

  it("moves to the store build's copy when that one is newer", async () => {
    vi.useFakeTimers();
    try {
      const { updater, plugin, dropShellCaches } = onBundle("0.2.0", "0.3.0");
      // Found on a simulator: the plugin answers before the page reloads.
      vi.mocked(plugin.reset).mockResolvedValue();
      let resolved = false;
      void updater.confirmBoot().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      // The bundle is vouched for first, so the plugin does not roll it back
      // on top of the move.
      expect(plugin.notifyAppReady).toHaveBeenCalledTimes(1);
      expect(dropShellCaches).toHaveBeenCalled();
      expect(plugin.reset).toHaveBeenCalledTimes(1);
      // The page is reloading: the app must not open the database meanwhile.
      expect(resolved).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads the page itself when the move does not, and does not try again", async () => {
    vi.useFakeTimers();
    try {
      const { updater, plugin, storage, reload } = onBundle("0.2.0", "0.3.0");
      vi.mocked(plugin.reset).mockResolvedValue();
      let resolved = false;
      void updater.confirmBoot().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(6000);
      expect(reload).toHaveBeenCalledTimes(1);
      // The old code never boots with the move under way.
      expect(resolved).toBe(false);
      expect(storage.state().storeCopyTried).toBe("0.3.0");

      // The reload brought this bundle back: it boots and does not move again.
      const again = onBundle("0.2.0", "0.3.0", storage.state());
      await again.updater.confirmBoot();
      expect(again.plugin.reset).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads the page when the plugin never answers the move", async () => {
    vi.useFakeTimers();
    try {
      const { updater, reload } = onBundle("0.2.0", "0.3.0");
      let resolved = false;
      void updater.confirmBoot().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(5100);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("boots once a move that outlasted the time limit is refused", async () => {
    vi.useFakeTimers();
    try {
      const { updater, plugin, reload } = onBundle("0.2.0", "0.3.0");
      // A slow plugin: the move starts at 3 s and is refused at 5.5 s, after
      // the 5 s limit.
      vi.mocked(plugin.current).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  bundle: { id: "bundle-1", version: "0.2.0" },
                  native: "0.3.0",
                }),
              3000,
            ),
          ),
      );
      vi.mocked(plugin.reset).mockImplementation(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Reset failed")), 2500),
          ),
      );
      let resolved = false;
      void updater.confirmBoot().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(5200);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(resolved).toBe(true);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a move once the app has booted without it", async () => {
    vi.useFakeTimers();
    try {
      const { updater, plugin } = onBundle("0.2.0", "0.3.0");
      vi.mocked(plugin.current).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  bundle: { id: "bundle-1", version: "0.2.0" },
                  native: "0.3.0",
                }),
              7000,
            ),
          ),
      );
      let resolved = false;
      void updater.confirmBoot().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(5100);
      expect(resolved).toBe(true);
      await vi.advanceTimersByTimeAsync(3000);
      expect(plugin.reset).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("boots the bundle it has when the plugin refuses the move", async () => {
    const { updater, plugin } = onBundle("0.2.0", "0.3.0");
    vi.mocked(plugin.reset).mockRejectedValue(new Error("Reset failed"));
    await updater.confirmBoot();
    expect(plugin.reset).toHaveBeenCalledTimes(1);
  });

  it("tries again for a later store build", async () => {
    const { updater, plugin } = onBundle("0.2.0", "0.4.0", {
      storeCopyTried: "0.3.0",
    });
    // Refused, so the test does not have to wait out the reload.
    vi.mocked(plugin.reset).mockRejectedValue(new Error("Reset failed"));
    await updater.confirmBoot();
    expect(plugin.reset).toHaveBeenCalledTimes(1);
  });

  it("does not move in a dev build", async () => {
    const { updater, plugin } = setup({
      runningVersion: "0.2.0",
      enabled: false,
    });
    vi.mocked(plugin.current).mockResolvedValue({
      bundle: { id: "bundle-1", version: "0.2.0" },
      native: "0.3.0",
    });
    await updater.confirmBoot();
    expect(plugin.notifyAppReady).toHaveBeenCalledTimes(1);
    expect(plugin.reset).not.toHaveBeenCalled();
  });

  it("deletes downloaded bundles the store build's copy has caught up with", async () => {
    const { updater, plugin } = setup({
      runningVersion: "0.3.0",
      state: { pending: { id: "bundle-4", version: "0.4.0" } },
    });
    vi.mocked(plugin.current).mockResolvedValue({
      bundle: { id: "builtin", version: "builtin" },
      native: "0.3.0",
    });
    vi.mocked(plugin.list).mockResolvedValue({
      bundles: [
        { id: "builtin", version: "builtin", status: "success" },
        { id: "bundle-2", version: "0.2.0", status: "success" },
        { id: "bundle-3", version: "0.3.0", status: "success" },
        { id: "bundle-4", version: "0.4.0", status: "pending" },
      ],
    });
    await updater.confirmBoot();
    await vi.waitFor(() => expect(plugin.delete).toHaveBeenCalledTimes(2));
    expect(plugin.delete).toHaveBeenCalledWith({ id: "bundle-2" });
    expect(plugin.delete).toHaveBeenCalledWith({ id: "bundle-3" });
  });
});
