import { useState, useEffect, useCallback, useContext } from "react";
import { CLIENT_VERSION, meetsMinimumVersion } from "@/version";
import { getPlatform, type Platform } from "@/platform";
import { WebSocketContext } from "@/app/contexts/WebSocketContext";

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
  // Track if WebSocket notified us of an update (instant notification on reconnect)
  const [wsUpdateInfo, setWsUpdateInfo] = useState<{
    serverVersion: number;
    forceUpdate: boolean;
  } | null>(null);

  const platform = getPlatform();

  // Get WebSocket context if available (may be null if outside WebSocketProvider)
  const wsContext = useContext(WebSocketContext);

  const checkVersion = useCallback(async () => {
    try {
      const response = await fetch("/api/version", {
        headers: {
          "X-Client-Version": String(CLIENT_VERSION),
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

  // Subscribe to WebSocket update-available notifications (if WebSocket context is available)
  // This provides instant notification on reconnect after server deploy
  useEffect(() => {
    if (!wsContext) return;

    const unsubscribe = wsContext.onUpdateAvailable((info) => {
      console.log("[VersionCheck] WebSocket update notification:", info);
      setWsUpdateInfo({
        serverVersion: info.serverVersion,
        forceUpdate: info.forceUpdate,
      });
      // Also trigger an HTTP check to get full version info (update URLs, etc.)
      checkVersion();
    });
    return unsubscribe;
  }, [wsContext, checkVersion]);

  // Calculate derived state
  // Use WebSocket info if available (instant), fall back to HTTP info
  const meetsMinimum = wsUpdateInfo
    ? !wsUpdateInfo.forceUpdate
    : versionInfo
      ? meetsMinimumVersion(CLIENT_VERSION, versionInfo.minVersion)
      : true; // Assume OK if we can't check

  const updateAvailable = wsUpdateInfo
    ? true // WebSocket told us there's an update
    : versionInfo
      ? CLIENT_VERSION < versionInfo.latestVersion
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
