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
import type { Platform } from "@/platform";

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
  platform: Platform;
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

export function VersionProvider({ children }: { children: ReactNode }) {
  const {
    isLoading,
    versionInfo,
    meetsMinimum,
    updateAvailable: apiUpdateAvailable,
    platform,
    updateUrl,
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

  const performUpdate = useCallback(() => {
    // If service worker has a waiting update, activate it
    if (activateServiceWorker) {
      activateServiceWorker();
      // Reload after a brief delay to let SW activate
      setTimeout(() => {
        window.location.reload();
      }, 100);
      return;
    }

    // If we have a platform-specific update URL, open it
    if (updateUrl) {
      window.open(updateUrl, "_blank");
      return;
    }

    // Default: just reload to get latest assets
    window.location.reload();
  }, [activateServiceWorker, updateUrl]);

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
