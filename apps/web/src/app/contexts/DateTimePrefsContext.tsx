import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  DEVICE_DATE_TIME_PREFS,
  getDateTimePrefs,
  installDateTimePrefs,
  subscribeDateTimePrefs,
  type DateTimePrefs,
} from "@/lib/dateTimePreferences";
import { OWN_PREF_KEYS, useOwnPref } from "./OwnPrefsContext";

/**
 * The bridge between the Date & Time preferences, which follow the person to
 * every device, and the formatters in `@/lib/dateTimePreferences`, which are
 * called synchronously from pure helpers that cannot await a database read.
 *
 * This provider is the only writer of that module's snapshot. Mount it inside
 * `OwnPrefsProvider`; anywhere below it, `useDateTimePrefs()` re-renders when
 * the person changes a setting here or on another of their devices.
 */

/** Which own-pref key each field is kept under. */
const PREF_KEYS: Record<keyof DateTimePrefs, string> = {
  timeFormat: OWN_PREF_KEYS.dateTimeTimeFormat,
  dateFormat: OWN_PREF_KEYS.dateTimeDateFormat,
  weekStart: OWN_PREF_KEYS.dateTimeWeekStart,
  timezone: OWN_PREF_KEYS.dateTimeTimezone,
};

/**
 * Read and write one Date & Time setting. For the settings tab — everywhere
 * else wants `useDateTimePrefs()` and the formatters, not the raw choice.
 */
export function useDateTimePref<K extends keyof DateTimePrefs>(
  field: K,
): { value: DateTimePrefs[K]; set: (next: DateTimePrefs[K]) => void } {
  return useOwnPref<DateTimePrefs[K]>(
    PREF_KEYS[field],
    DEVICE_DATE_TIME_PREFS[field],
  );
}

export function DateTimePrefsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const timeFormat = useDateTimePref("timeFormat").value;
  const dateFormat = useDateTimePref("dateFormat").value;
  const weekStart = useDateTimePref("weekStart").value;
  const timezone = useDateTimePref("timezone").value;

  const prefs = useMemo(
    () => ({ timeFormat, dateFormat, weekStart, timezone }),
    [timeFormat, dateFormat, weekStart, timezone],
  );

  // Installed after the render rather than during it, because installing
  // notifies subscribers and a subscriber cannot be told to re-render while
  // this one is still rendering. The frame that costs is not visible: the
  // register is read asynchronously, so the first paint of a cold start shows
  // the device defaults either way.
  useEffect(() => {
    installDateTimePrefs(prefs);
  }, [prefs]);

  // One person's choices must not outlive their session: on unmount — signing
  // out, or a workspace going away — the formatters go back to answering for
  // the device rather than for whoever was last signed in.
  useEffect(() => () => installDateTimePrefs(DEVICE_DATE_TIME_PREFS), []);

  return <>{children}</>;
}

/**
 * The Date & Time settings in force, re-rendering when any of this person's
 * devices changes one.
 *
 * Call it in any component that formats a date or a time — including one that
 * only formats inside a `useMemo`, which otherwise keeps showing a 12-hour
 * clock after the person switches to 24-hour on their laptop. The returned
 * value is stable between changes, so it works as a `useMemo` dependency.
 */
export function useDateTimePrefs(): DateTimePrefs {
  return useSyncExternalStore(
    subscribeDateTimePrefs,
    getDateTimePrefs,
    getDateTimePrefs,
  );
}
