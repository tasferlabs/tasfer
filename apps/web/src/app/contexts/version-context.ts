import { createContext } from "react";
import type { ClientPlatform } from "@/platform";
import type { VersionInfo } from "../hooks/useVersionCheck";

export interface VersionContextValue {
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

export const VersionContext = createContext<VersionContextValue | null>(null);
