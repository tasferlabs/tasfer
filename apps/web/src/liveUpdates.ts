/**
 * Live (OTA) web-bundle updates on iOS and Android.
 *
 * `@capgo/capacitor-updater` checks our own server (apps/updates) on every
 * foreground and downloads newer bundles in the background. It is configured
 * `autoUpdate: "onlyDownload"`, so it never swaps the running bundle on its
 * own — a downloaded bundle sits on disk until this module applies it, which
 * happens only when the user accepts the update prompt. A document editor must
 * not reload itself mid-edit.
 *
 * Everything here is a no-op off native: the plugin is imported dynamically so
 * its JS never reaches the web or Electron bundle, and every call is wrapped —
 * a broken update path must never be able to stop the app from starting.
 */

import type { BundleInfo } from "@capgo/capacitor-updater";

/** Native only. Electron and web have their own update paths. */
export function isLiveUpdateHost(): boolean {
  return !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor?.isNativePlatform?.();
}

async function plugin() {
  const { CapacitorUpdater } = await import("@capgo/capacitor-updater");
  return CapacitorUpdater;
}

/**
 * Tell the plugin this bundle actually works.
 *
 * This is the entire rollback mechanism: a bundle that does not report in
 * within `appReadyTimeout` is treated as broken and the previous one — the
 * built-in bundle, in the worst case — is restored on the next launch.
 *
 * Call it only once the app has really started: after the platform layer is up
 * (database open, worker running) and the first render has happened. Calling it
 * at module scope would mark a bundle healthy that merely parsed, which is
 * exactly the failure rollback exists to catch.
 */
export async function markBundleHealthy(): Promise<void> {
  if (!isLiveUpdateHost()) return;
  try {
    await (await plugin()).notifyAppReady();
  } catch (err) {
    console.error("[LiveUpdate] notifyAppReady failed:", err);
  }
}

/**
 * Bundle versions are plain `X.Y.Z` by construction (the release pipeline
 * enforces it). Anything else — the placeholder the plugin reports before it
 * has bundle metadata, most often — is not comparable, and "not comparable"
 * must mean "do not offer it", never "assume newer".
 */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    /^\d+\.\d+\.\d+$/.test(v) ? (v.split(".").map(Number) as [number, number, number]) : null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) > 0;
}

/**
 * The newest downloaded bundle that is ready to replace the running one, or
 * null when there is nothing to apply.
 *
 * Derived from what is on disk rather than from a "download finished" event,
 * so it is correct on a cold start that follows a download in a previous
 * session — the common case, since downloads happen in the background.
 */
export async function findReadyBundle(): Promise<BundleInfo | null> {
  if (!isLiveUpdateHost()) return null;
  try {
    const updater = await plugin();
    const { bundle: current } = await updater.current();
    const { bundles } = await updater.list();
    let best: BundleInfo | null = null;
    for (const bundle of bundles) {
      // 'downloading' is not finished; 'error' failed its health check once
      // already and must not be offered again.
      if (bundle.status !== "success" && bundle.status !== "pending") continue;
      if (!isNewer(bundle.version, current.version)) continue;
      if (!best || isNewer(bundle.version, best.version)) best = bundle;
    }
    return best;
  } catch (err) {
    console.error("[LiveUpdate] failed to list bundles:", err);
    return null;
  }
}

/**
 * Subscribe to the plugin's download outcomes. Returns an unsubscribe.
 *
 * Only a signal to re-check `findReadyBundle()` — the event payload is not
 * trusted to decide what is applicable.
 */
export function onLiveUpdateChange(listener: () => void): () => void {
  if (!isLiveUpdateHost()) return () => {};
  const handles: Array<{ remove: () => Promise<void> }> = [];
  let cancelled = false;

  void (async () => {
    try {
      const updater = await plugin();
      // Registered one by one rather than over a list: addListener is
      // overloaded per event name, so a loop erases the payload types.
      handles.push(await updater.addListener("downloadComplete", listener));
      handles.push(await updater.addListener("updateAvailable", listener));
      handles.push(await updater.addListener("downloadFailed", listener));
      handles.push(await updater.addListener("updateFailed", listener));
    } catch (err) {
      console.error("[LiveUpdate] failed to attach listeners:", err);
    }
    if (cancelled) for (const handle of handles) void handle.remove();
  })();

  return () => {
    cancelled = true;
    for (const handle of handles) void handle.remove();
  };
}

/**
 * Swap to a downloaded bundle. The plugin reloads the WebView, so nothing after
 * this runs — treat it as a navigation, not a function call.
 */
export async function applyBundle(bundle: BundleInfo): Promise<void> {
  const updater = await plugin();
  await updater.set({ id: bundle.id });
}
