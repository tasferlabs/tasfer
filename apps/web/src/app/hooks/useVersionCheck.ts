import { useState, useCallback } from "react";
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
}

/**
 * Version check hook.
 *
 * In the decentralized model there's no central API to check against.
 * This returns safe defaults — the app is always considered up to date.
 * Version updates are handled via the platform's own update mechanism
 * (Electron auto-updater, app store, etc.).
 */
export function useVersionCheck(): VersionCheckResult {
  const [isLoading] = useState(false);
  const [error] = useState<string | null>(null);
  const [versionInfo] = useState<VersionInfo | null>(null);

  const platform = getClientPlatform();

  const checkVersion = useCallback(async () => {
    // No central server to check against in decentralized mode.
    // Version updates are handled by the platform (Electron auto-updater, etc.)
  }, []);

  return {
    isLoading,
    error,
    versionInfo,
    meetsMinimum: true,
    updateAvailable: false,
    platform,
    updateUrl: null,
    refresh: checkVersion,
  };
}
