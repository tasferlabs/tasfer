import {
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { invariant } from "@shared/invariant";
import { useVersionCheck } from "../hooks/useVersionCheck";
import { serviceWorkerBridge } from "@/serviceWorkerBridge";
import { VersionContext } from "./version-context";

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
    updateAvailable: apiUpdateAvailable,
    updateVersion,
    updateDownloading,
    downloadPercent,
    updateDownloaded,
    platform,
    checkForUpdate,
    performPlatformUpdate,
  } = useVersionCheck();

  const [serviceWorkerUpdateReady, setServiceWorkerUpdateReady] =
    useState(false);
  const [activateServiceWorker, setActivateServiceWorker] = useState<
    (() => void) | null
  >(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

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
  }, []);

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
        window.location.reload();
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
        window.location.reload();
      }, 2000);
      return;
    }

    // Default: caches are already cleared, so a plain reload fetches fresh assets
    window.location.reload();
  }, [activateServiceWorker, performPlatformUpdate]);

  return (
    <VersionContext.Provider
      value={{
        isLoading,
        updateAvailable,
        updateVersion,
        updateDownloading,
        downloadPercent,
        updateDownloaded,
        updateDismissed,
        serviceWorkerUpdateReady,
        platform,
        dismissUpdate,
        checkForUpdate,
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
  invariant(context, "useVersion must be used within a VersionProvider");
  return context;
}
