/**
 * `tasfer host --auto-update` — keep a running host on the newest build.
 *
 * Once soon after start and then about once a day, the host does what
 * `tasfer update` does — find the newest release with a build for this
 * machine, check its checksum, swap it in — and then restarts itself in place
 * (see `control.ts`), so the new build is the one that comes back.
 *
 * Two rules make this safe to leave on a box nobody watches:
 *
 * - A release is only taken once it has been out for a few days, and never a
 *   pre-release. A broken build that reaches people who update by hand can be
 *   pulled before it reaches every host.
 * - Any failure leaves the host running on the build it has. Nothing here is
 *   allowed to stop it; the next check simply tries again.
 */

import { dirname } from "node:path";
import { t } from "../cli/messages";
import {
  compareVersions,
  installDir,
  installRelease,
  latestRelease,
} from "../cli/update";
import { VERSION } from "../version";
import { isPackaged } from "./native";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a release must have been out before a host takes it. */
export const AUTO_UPDATE_MIN_AGE_DAYS = 3;

/** The first check, a little after start so it does not crowd startup. */
const FIRST_CHECK_MS = { min: 10_000, max: 60_000 };

/** Spread hosts that started together so they do not all ask at once. */
const INTERVAL_MS = { min: DAY_MS - 2 * 60 * 60 * 1000, max: DAY_MS + 2 * 60 * 60 * 1000 };

function between({ min, max }: { min: number; max: number }): number {
  return min + Math.random() * (max - min);
}

export interface AutoUpdater {
  /** No more checks. One in progress finishes, but restarts nothing. */
  stop(): void;
}

/**
 * Start checking, or explain why this install cannot update itself and return
 * null. `onInstalled` runs once a new build is in place.
 */
export async function startAutoUpdate(
  onInstalled: (version: string) => void,
): Promise<AutoUpdater | null> {
  let dir: string;
  try {
    dir = await installDir();
  } catch (e) {
    // A released build that cannot write its own directory is a system-wide
    // install run by a service account: root updates it, from a timer.
    console.warn(
      isPackaged()
        ? t("autoUpdate.notWritable", { path: dirname(process.execPath) })
        : t("autoUpdate.off", { reason: e instanceof Error ? e.message : String(e) }),
    );
    return null;
  }

  console.log(t("autoUpdate.on", { days: AUTO_UPDATE_MIN_AGE_DAYS }));

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delay: number) => {
    timer = setTimeout(() => void check(), delay);
    // The host's own heartbeat keeps the process alive, not this.
    timer.unref();
  };

  const check = async () => {
    try {
      const newest = await latestRelease({
        minAgeMs: AUTO_UPDATE_MIN_AGE_DAYS * DAY_MS,
      });
      if (stopped) return;
      if (newest && compareVersions(newest.version, VERSION) > 0) {
        console.log(
          t("autoUpdate.installing", { version: newest.version, current: VERSION }),
        );
        await installRelease(newest, dir);
        if (stopped) return;
        console.log(t("autoUpdate.installed", { version: newest.version }));
        onInstalled(newest.version);
        return;
      }
    } catch (e) {
      console.warn(
        t("autoUpdate.failed", { reason: e instanceof Error ? e.message : String(e) }),
      );
    }
    if (!stopped) schedule(between(INTERVAL_MS));
  };

  schedule(between(FIRST_CHECK_MS));

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
