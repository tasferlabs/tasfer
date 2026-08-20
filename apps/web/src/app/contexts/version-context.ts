import { createContext } from "react";
import type { ClientPlatform } from "@/platform";
import type {
  UpdateCheckOutcome,
  VersionInfo,
} from "../hooks/useVersionCheck";

export interface VersionContextValue {
  /** Whether version check is loading */
  isLoading: boolean;
  /** Version info from API */
  versionInfo: VersionInfo | null;
  /** Whether a soft update is available (shows popup) */
  updateAvailable: boolean;
  /** Version string of the pending update, when the host reports one */
  updateVersion: string | null;
  /** Whether the pending update is downloading right now */
  updateDownloading: boolean;
  /** Download progress 0–100 while downloading, null otherwise */
  downloadPercent: number | null;
  /** Whether the update is downloaded and only needs a restart */
  updateDownloaded: boolean;
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
  /** Check for an update on demand and report what was found (desktop only) */
  checkForUpdate: () => Promise<UpdateCheckOutcome>;
  /** Trigger app update (reload, install the downloaded desktop update, or navigate to the update URL) */
  performUpdate: () => Promise<void>;
  /** Called by service worker registration when new version is ready */
  setServiceWorkerUpdateReady: (ready: boolean) => void;
  /** Function to activate the waiting service worker */
  activateServiceWorker: (() => void) | null;
  /** Set the service worker activation function */
  setActivateServiceWorker: (fn: (() => void) | null) => void;
}

export const VersionContext = createContext<VersionContextValue | null>(null);
