import { useState, useCallback, useEffect, useRef } from "react";
import { getClientPlatform, type ClientPlatform } from "@/platform";

export interface UpdateUrls {
  ios: string | null;
  android: string | null;
  web: string | null;
}

export interface VersionInfo {
  minVersion: number;
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
  /** Whether the client meets minimum version requirements */
  meetsMinimum: boolean;
  /** Whether a newer version is available */
  updateAvailable: boolean;
  /** Current platform */
  platform: ClientPlatform;
  /** Update URL for current platform */
  updateUrl: string | null;
  /** Refresh version check */
  refresh: () => void;
  /** Platform-specific update action (download + install) */
  performPlatformUpdate: (() => Promise<void>) | null;
}

type CypherBridge = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): () => void;
};

function getElectronBridge(): CypherBridge | null {
  if (typeof window !== "undefined" && (window as any).cypher) {
    return (window as any).cypher as CypherBridge;
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
  const [updateDownloaded, setUpdateDownloaded] = useState(false);

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
      bridge.on("updater:available", () => {
        setIsLoading(false);
        setUpdateAvailable(true);
      }),
    );

    unsubs.push(
      bridge.on("updater:not-available", () => {
        setIsLoading(false);
        setUpdateAvailable(false);
      }),
    );

    unsubs.push(
      bridge.on("updater:downloaded", () => {
        setUpdateDownloaded(true);
      }),
    );

    unsubs.push(
      bridge.on("updater:error", (data: any) => {
        setIsLoading(false);
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
    } else {
      await bridge.invoke("updater:download");
      // updater:downloaded event will fire → then user can trigger install
    }
  }, [updateDownloaded]);

  return {
    isLoading,
    error,
    versionInfo: null,
    meetsMinimum: true, // Desktop users should never be blocked from local data
    updateAvailable,
    platform,
    updateUrl: null,
    refresh,
    performPlatformUpdate: bridgeRef.current ? performPlatformUpdate : null,
  };
}
