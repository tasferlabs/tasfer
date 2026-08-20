import { useState, useCallback, useEffect, useRef } from "react";
import { getClientPlatform, type ClientPlatform } from "@/platform";

export interface UpdateUrls {
  ios: string | null;
  android: string | null;
  web: string | null;
}

export interface VersionInfo {
  latestVersion: number;
  updateUrls: UpdateUrls;
}

export interface VersionCheckResult {
  /** Whether version check is still loading */
  isLoading: boolean;
  /** Error message if version check failed */
  error: string | null;
  /** Version info from the API */
  versionInfo: VersionInfo | null;
  /** Whether a newer version is available */
  updateAvailable: boolean;
  /** Version string of the pending update, when the host reports one */
  updateVersion: string | null;
  /** Whether the pending update is downloading right now */
  updateDownloading: boolean;
  /** Download progress 0–100 while downloading, null otherwise */
  downloadPercent: number | null;
  /** Whether the update is downloaded and only needs a restart */
  updateDownloaded: boolean;
  /** Current platform */
  platform: ClientPlatform;
  /** Update URL for current platform */
  updateUrl: string | null;
  /** Refresh version check */
  refresh: () => void;
  /** Platform-specific update action (download + install) */
  performPlatformUpdate: (() => Promise<void>) | null;
}

type TasferBridge = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): () => void;
};

function getElectronBridge(): TasferBridge | null {
  if (typeof window !== "undefined" && (window as any).tasfer) {
    return (window as any).tasfer as TasferBridge;
  }
  return null;
}

/**
 * Version check hook.
 *
 * On Electron: subscribes to auto-updater IPC events from the main process.
 * On other platforms: returns safe defaults (no central server to check).
 */
export function useVersionCheck(): VersionCheckResult {
  const platform = getClientPlatform();
  const bridgeRef = useRef(getElectronBridge());

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);

  // The 4-hourly re-check re-announces an update that is already downloaded and
  // waiting for a restart. Remember which version reached "downloaded" so those
  // repeats don't drag the UI back to "downloading".
  const downloadedVersion = useRef<string | null>(null);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;

    const unsubs: (() => void)[] = [];

    unsubs.push(
      bridge.on("updater:checking", () => {
        setIsLoading(true);
        setError(null);
      }),
    );

    unsubs.push(
      bridge.on("updater:available", (data: any) => {
        const version = data?.version ?? null;
        setIsLoading(false);
        setUpdateAvailable(true);
        setUpdateVersion(version);
        if (version && version === downloadedVersion.current) return;
        // Main downloads automatically; progress events follow.
        setUpdateDownloading(true);
      }),
    );

    unsubs.push(
      bridge.on("updater:not-available", () => {
        setIsLoading(false);
        setUpdateAvailable(false);
      }),
    );

    unsubs.push(
      bridge.on("updater:progress", (data: any) => {
        if (downloadedVersion.current) return;
        setUpdateDownloading(true);
        const percent = data?.percent;
        setDownloadPercent(typeof percent === "number" ? percent : null);
      }),
    );

    unsubs.push(
      bridge.on("updater:downloaded", (data: any) => {
        downloadedVersion.current = data?.version ?? null;
        setUpdateAvailable(true);
        if (data?.version) setUpdateVersion(data.version);
        setUpdateDownloading(false);
        setDownloadPercent(null);
        setUpdateDownloaded(true);
      }),
    );

    unsubs.push(
      bridge.on("updater:error", (data: any) => {
        setIsLoading(false);
        setUpdateDownloading(false);
        setDownloadPercent(null);
        setError(data?.message ?? "Update check failed");
      }),
    );

    return () => unsubs.forEach((fn) => fn());
  }, []);

  const refresh = useCallback(() => {
    const bridge = bridgeRef.current;
    if (bridge) {
      bridge.invoke("updater:check").catch(() => {});
    }
  }, []);

  const performPlatformUpdate = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;

    if (updateDownloaded) {
      await bridge.invoke("updater:install");
      return;
    }

    // Downloads normally start on their own; this covers a download that never
    // began (or failed) without making the user wait for the next check.
    setUpdateDownloading(true);
    setError(null);
    try {
      await bridge.invoke("updater:download");
    } catch {
      setUpdateDownloading(false);
    }
    // updater:downloaded flips the banner to its restart state.
  }, [updateDownloaded]);

  return {
    isLoading,
    error,
    versionInfo: null,
    updateAvailable,
    updateVersion,
    updateDownloading,
    downloadPercent,
    updateDownloaded,
    platform,
    updateUrl: null,
    refresh,
    performPlatformUpdate: bridgeRef.current ? performPlatformUpdate : null,
  };
}
