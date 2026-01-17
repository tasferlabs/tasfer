import { useState, useEffect, useCallback } from "react";
import { CLIENT_VERSION, meetsMinimumVersion } from "@/version";
import { getPlatform, type Platform } from "@/platform";

export interface UpdateUrls {
  ios: string | null;
  android: string | null;
  web: string | null;
}

export interface VersionInfo {
  apiVersion: string;
  minClientVersion: string;
  recommendedClientVersion: string;
  updateMessage: string | null;
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
  /** Whether a newer recommended version is available */
  updateAvailable: boolean;
  /** Current platform */
  platform: Platform;
  /** Update URL for current platform */
  updateUrl: string | null;
  /** Refresh version check */
  refresh: () => void;
}

const VERSION_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

export function useVersionCheck(): VersionCheckResult {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);

  const platform = getPlatform();

  const checkVersion = useCallback(async () => {
    try {
      const response = await fetch("/api/version", {
        headers: {
          "X-Client-Version": CLIENT_VERSION,
          "X-Client-Platform": platform,
        },
      });

      if (!response.ok) {
        throw new Error(`Version check failed: ${response.status}`);
      }

      const data = await response.json();
      if (data.success) {
        setVersionInfo(data.data);
        setError(null);
      } else {
        throw new Error(data.error || "Unknown error");
      }
    } catch (err) {
      // Don't block app if version check fails - could be offline
      console.warn("[VersionCheck] Failed to check version:", err);
      setError(err instanceof Error ? err.message : "Version check failed");
    } finally {
      setIsLoading(false);
    }
  }, [platform]);

  // Initial check
  useEffect(() => {
    checkVersion();
  }, [checkVersion]);

  // Periodic re-check (in case API updates minVersion while app is open)
  useEffect(() => {
    const interval = setInterval(checkVersion, VERSION_CHECK_INTERVAL);
    return () => clearInterval(interval);
  }, [checkVersion]);

  // Also check when app comes back online
  useEffect(() => {
    const handleOnline = () => {
      checkVersion();
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [checkVersion]);

  // Calculate derived state
  const meetsMinimum = versionInfo
    ? meetsMinimumVersion(CLIENT_VERSION, versionInfo.minClientVersion)
    : true; // Assume OK if we can't check

  const updateAvailable = versionInfo
    ? !meetsMinimumVersion(CLIENT_VERSION, versionInfo.recommendedClientVersion)
    : false;

  // Get platform-specific update URL
  const updateUrl = versionInfo?.updateUrls?.[platform] ?? null;

  return {
    isLoading,
    error,
    versionInfo,
    meetsMinimum,
    updateAvailable,
    platform,
    updateUrl,
    refresh: checkVersion,
  };
}
