import {
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  MobileUpdateCheckOutcome,
  MobileUpdater,
  MobileUpdateStatus,
} from "@/platform/mobileUpdate";

/** A status worth showing: anything but "nothing to do". */
export type MobileUpdateNotice = Exclude<MobileUpdateStatus, { phase: "idle" }>;

export interface MobileUpdateContextValue {
  /** Where the update stands, whether or not anything is shown for it. */
  status: MobileUpdateStatus;
  /**
   * What the sidebar card shows, or null for no card. Null while "Update
   * automatically" is on: that mode never asks, so it never shows anything.
   * The one exception is a version that needs a store update first, which no
   * setting can fetch for the person.
   */
  notice: MobileUpdateNotice | null;
  /** Whether new versions are downloaded without asking. */
  autoUpdate: boolean;
  setAutoUpdate: (on: boolean) => void;
  /** The card is shrunk to one line: the person's "not now". */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** Downloads the version on offer. */
  download: () => Promise<void>;
  /** Restarts into the downloaded version. */
  restart: () => void;
  /**
   * Looks for a new version right now. `version` is the one found, or null
   * when there is none.
   */
  check: () => Promise<{
    outcome: MobileUpdateCheckOutcome;
    version: string | null;
  }>;
}

const MobileUpdateContext = createContext<MobileUpdateContextValue | null>(
  null,
);

const NO_SUBSCRIPTION = () => () => {};
const IDLE: MobileUpdateStatus = { phase: "idle" };

/**
 * Hands the phone apps' over-the-air updater (platform/mobileUpdate.ts) to the
 * UI. `updater` is null everywhere but the iOS and Android apps, and then
 * `useMobileUpdate` returns null and nothing about updates is drawn.
 */
export function MobileUpdateProvider({
  updater,
  children,
}: {
  updater: MobileUpdater | null;
  children: ReactNode;
}) {
  const status = useSyncExternalStore(
    updater ? updater.subscribe : NO_SUBSCRIPTION,
    () => (updater ? updater.getStatus() : IDLE),
  );
  const autoUpdate = useSyncExternalStore(
    updater ? updater.subscribe : NO_SUBSCRIPTION,
    () => (updater ? updater.getAutoUpdate() : false),
  );
  // Held for this launch only, like the desktop banner: by the next launch a
  // downloaded update is in, and an offer that was put off is worth one more
  // mention.
  const [collapsed, setCollapsed] = useState(false);

  const value = useMemo<MobileUpdateContextValue | null>(() => {
    if (!updater) return null;
    return {
      status,
      notice:
        status.phase === "idle" || (autoUpdate && status.phase !== "store")
          ? null
          : status,
      autoUpdate,
      setAutoUpdate: updater.setAutoUpdate,
      collapsed,
      setCollapsed,
      download: updater.downloadUpdate,
      restart: updater.restartToUpdate,
      check: async () => {
        const outcome = await updater.checkForUpdate({ force: true });
        const found = updater.getStatus();
        return {
          outcome,
          version: found.phase === "idle" ? null : found.version,
        };
      },
    };
  }, [updater, status, autoUpdate, collapsed]);

  return (
    <MobileUpdateContext.Provider value={value}>
      {children}
    </MobileUpdateContext.Provider>
  );
}

/** The phone apps' updater, or null where the app does not update this way. */
export function useMobileUpdate(): MobileUpdateContextValue | null {
  return useContext(MobileUpdateContext);
}
