import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { useVersionCheck, type VersionInfo } from "../hooks/useVersionCheck";
import { serviceWorkerBridge } from "@/serviceWorkerBridge";
import type { ClientPlatform } from "@/platform";

interface VersionContextValue {
  /** Whether version check is loading */
  isLoading: boolean;
  /** Version info from API */
  versionInfo: VersionInfo | null;
  /** Whether client meets minimum version (blocks app if false) */
  meetsMinimum: boolean;
  /** Whether a soft update is available (shows popup) */
  updateAvailable: boolean;
  /** Whether the update popup has been dismissed this session */
  updateDismissed: boolean;
  /** Whether the service worker detected a new version */
  serviceWorkerUpdateReady: boolean;
  /** Current platform (ios, android, web) */
  platform: ClientPlatform;
  /** Platform-specific update URL */
  updateUrl: string | null;
  /** Dismiss the update popup for this session */
  dismissUpdate: () => void;
  /** Trigger app update (reload or navigate to update URL) */
  performUpdate: () => void;
  /** Called by service worker registration when new version is ready */
  setServiceWorkerUpdateReady: (ready: boolean) => void;
  /** Function to activate the waiting service worker */
  activateServiceWorker: (() => void) | null;
  /** Set the service worker activation function */
  setActivateServiceWorker: (fn: (() => void) | null) => void;
}

const VersionContext = createContext<VersionContextValue | null>(null);

const DISMISS_KEY = "update-dismissed-version";

// Clear all service worker caches before update
async function clearAllCaches(): Promise<void> {
  try {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map((name) => caches.delete(name)));
    console.log("[Version] Cleared caches:", cacheNames);
  } catch (e) {
    console.error("[Version] Failed to clear caches:", e);
  }
}

export function VersionProvider({ children }: { children: ReactNode }) {
  const {
    isLoading,
    versionInfo,
    meetsMinimum,
    updateAvailable: apiUpdateAvailable,
    platform,
    updateUrl,
    performPlatformUpdate,
  } = useVersionCheck();

  const [serviceWorkerUpdateReady, setServiceWorkerUpdateReady] =
    useState(false);
  const [activateServiceWorker, setActivateServiceWorker] = useState<
    (() => void) | null
  >(null);
  const [updateDismissed, setUpdateDismissed] = useState(() => {
    // Check if user already dismissed this version
    const dismissed = localStorage.getItem(DISMISS_KEY);
    if (dismissed && versionInfo) {
      return dismissed === String(versionInfo.latestVersion);
    }
    return false;
  });

  // Reset dismissed state if latest version changes
  useEffect(() => {
    if (versionInfo) {
      const dismissed = localStorage.getItem(DISMISS_KEY);
      if (dismissed !== String(versionInfo.latestVersion)) {
        setUpdateDismissed(false);
      }
    }
  }, [versionInfo]);

  // Connect to service worker bridge
  useEffect(() => {
    serviceWorkerBridge.setOnUpdate(() => {
      setServiceWorkerUpdateReady(true);
    });
    // Get activator if already available
    const activator = serviceWorkerBridge.getActivator();
    if (activator) {
      setActivateServiceWorker(() => activator);
    }
  }, []);

  // Update is available if API says so OR service worker has new version
  const updateAvailable = apiUpdateAvailable || serviceWorkerUpdateReady;

  const dismissUpdate = useCallback(() => {
    setUpdateDismissed(true);
    if (versionInfo) {
      localStorage.setItem(DISMISS_KEY, String(versionInfo.latestVersion));
    }
  }, [versionInfo]);

  const performUpdate = useCallback(async () => {
    // Electron: delegate to the native auto-updater
    if (performPlatformUpdate) {
      await performPlatformUpdate();
      return;
    }

    // Clear all caches first to ensure fresh resources
    await clearAllCaches();

    // If service worker has a waiting update, activate it
    if (activateServiceWorker) {
      // Wait for the new service worker to actually take control before reloading
      const onControllerChange = () => {
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          onControllerChange
        );
        window.location.href =
          window.location.pathname + "?_update=" + Date.now();
      };
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        onControllerChange
      );

      // Send skip waiting message to activate the waiting SW
      activateServiceWorker();

      // Fallback: if controllerchange doesn't fire within 2s, reload anyway
      setTimeout(() => {
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          onControllerChange
        );
        window.location.href =
          window.location.pathname + "?_update=" + Date.now();
      }, 2000);
      return;
    }

    // If we have a platform-specific update URL, open it
    if (updateUrl) {
      window.open(updateUrl, "_blank");
      return;
    }

    // Default: reload with cache-busting to get latest assets
    window.location.href = window.location.pathname + "?_update=" + Date.now();
  }, [activateServiceWorker, updateUrl, performPlatformUpdate]);

  return (
    <VersionContext.Provider
      value={{
        isLoading,
        versionInfo,
        meetsMinimum,
        updateAvailable,
        updateDismissed,
        serviceWorkerUpdateReady,
        platform,
        updateUrl,
        dismissUpdate,
        performUpdate,
        setServiceWorkerUpdateReady,
        activateServiceWorker,
        setActivateServiceWorker,
      }}
    >
      {children}
    </VersionContext.Provider>
  );
}

export function useVersion() {
  const context = useContext(VersionContext);
  if (!context) {
    throw new Error("useVersion must be used within a VersionProvider");
  }
  return context;
}
