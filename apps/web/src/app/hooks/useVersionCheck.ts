import { useState, useCallback, useEffect, useRef } from "react";
import { getClientPlatform, type ClientPlatform } from "@/platform";
import {
  applyBundle,
  findReadyBundle,
  isLiveUpdateHost,
  onLiveUpdateChange,
} from "@/liveUpdates";
import type { BundleInfo } from "@capgo/capacitor-updater";

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
 * On iOS/Android: reports a downloaded live-update bundle waiting to be
 * applied. The plugin does the checking and downloading on its own schedule
 * (see liveUpdates.ts); this hook only asks what is ready and applies it when
 * the user says so.
 * On web: returns safe defaults — the service worker owns updates there.
 */
export function useVersionCheck(): VersionCheckResult {
  const platform = getClientPlatform();
  const bridgeRef = useRef(getElectronBridge());

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const [readyBundle, setReadyBundle] = useState<BundleInfo | null>(null);

  // Live updates (iOS/Android). The plugin downloads in the background, so a
  // bundle can become ready between sessions — ask on mount, then re-ask
  // whenever the plugin reports a download outcome.
  useEffect(() => {
    if (!isLiveUpdateHost()) return;

    let active = true;
    const refreshReady = () => {
      void findReadyBundle().then((bundle) => {
        if (!active) return;
        setReadyBundle(bundle);
        setUpdateAvailable(!!bundle);
      });
    };

    refreshReady();
    const unsubscribe = onLiveUpdateChange(refreshReady);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

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
      return;
    }
    if (isLiveUpdateHost()) {
      void findReadyBundle().then((bundle) => {
        setReadyBundle(bundle);
        setUpdateAvailable(!!bundle);
      });
    }
  }, []);

  const performPlatformUpdate = useCallback(async () => {
    // Native first: applying a bundle reloads the WebView, so nothing after the
    // call runs.
    if (readyBundle) {
      await applyBundle(readyBundle);
      return;
    }

    const bridge = bridgeRef.current;
    if (!bridge) return;

    if (updateDownloaded) {
      await bridge.invoke("updater:install");
    } else {
      await bridge.invoke("updater:download");
      // updater:downloaded event will fire → then user can trigger install
    }
  }, [readyBundle, updateDownloaded]);

  return {
    isLoading,
    error,
    versionInfo: null,
    updateAvailable,
    platform,
    updateUrl: null,
    refresh,
    performPlatformUpdate:
      bridgeRef.current || readyBundle ? performPlatformUpdate : null,
  };
}
