import i18next from "i18next";

// ── Types ──

export type TimeFormat = "12h" | "24h" | "system";
export type DateFormat = "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD" | "system";
/** 0 = Sunday, 1 = Monday, 6 = Saturday */
export type WeekStart = 0 | 1 | 6;
/** An IANA zone id, or "system" to follow the device time zone. */
export type TimezonePreference = string;

// ── The live source ──

/** The four choices, as one value. */
export interface DateTimePrefs {
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  weekStart: WeekStart;
  timezone: TimezonePreference;
}

/**
 * What the formatters answer with before this person's choices have arrived —
 * and forever, in a host that never installs any (tests, the onboarding screen,
 * a story). Every field defers to the device except the week start, which has
 * no device answer to defer to.
 */
export const DEVICE_DATE_TIME_PREFS: DateTimePrefs = {
  timeFormat: "system",
  dateFormat: "system",
  weekStart: 1,
  timezone: "system",
};

/**
 * These preferences follow the person across their devices, so they live in the
 * own-prefs register (`dateTime.*` in `OWN_PREF_KEYS`) rather than in this
 * browser. The register is read asynchronously and can move underneath us when
 * another device changes it, but the formatters below are called from pure
 * layout helpers — calendar geometry, picker field order — that have no way to
 * await anything. So `DateTimePrefsProvider` keeps this snapshot pointed at the
 * current values and the helpers keep reading it synchronously.
 *
 * Read it in a component through `useDateTimePrefs()` (see the provider), which
 * re-renders when the value moves. Reading a formatter without that hook is
 * fine for a one-shot format, but the result will not update on its own when
 * the person changes the setting on their phone.
 */
let current: DateTimePrefs = DEVICE_DATE_TIME_PREFS;
const listeners = new Set<() => void>();

/**
 * Point the formatters at this person's choices. Idempotent: an unchanged value
 * notifies nobody, so the provider can call it on every render.
 */
export function installDateTimePrefs(next: DateTimePrefs): void {
  if (
    next.timeFormat === current.timeFormat &&
    next.dateFormat === current.dateFormat &&
    next.weekStart === current.weekStart &&
    next.timezone === current.timezone
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

/** Subscribe to changes from this person's other devices. */
export function subscribeDateTimePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current snapshot, stable between changes so it can back a store hook. */
export function getDateTimePrefs(): DateTimePrefs {
  return current;
}

// ── Reads ──

export function getTimeFormat(): TimeFormat {
  return current.timeFormat;
}

export function getDateFormat(): DateFormat {
  return current.dateFormat;
}

export function getWeekStart(): WeekStart {
  return current.weekStart;
}

export function getTimezone(): TimezonePreference {
  return current.timezone;
}

/** The IANA zone all dates are displayed in: the preference, or the device zone. */
export function getResolvedTimezone(): string {
  const pref = getTimezone();
  if (pref !== "system") return pref;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ── Formatting helpers ──

/** Returns the hour12 option for Intl/toLocaleTimeString based on user preference */
export function getHour12(): boolean | undefined {
  const pref = getTimeFormat();
  if (pref === "12h") return true;
  if (pref === "24h") return false;
  return undefined; // let browser locale decide
}

/**
 * Returns a locale string that enforces the user's date order preference.
 * "system" → i18next.language (browser default order)
 * "MM/DD/YYYY" → "en-US"
 * "DD/MM/YYYY" → "en-GB"
 * "YYYY-MM-DD" → "sv-SE" (ISO-like)
 */
function getDateOrderLocale(): string {
  const pref = getDateFormat();
  if (pref === "MM/DD/YYYY") return "en-US";
  if (pref === "DD/MM/YYYY") return "en-GB";
  if (pref === "YYYY-MM-DD") return "sv-SE";
  return i18next.language;
}

/**
 * Returns the appropriate locale for date formatting.
 * When the format includes textual elements (month/weekday names),
 * uses the UI language so names appear in the correct language.
 * For purely numeric formats, uses the date-order locale.
 */
function getDateLocale(opts?: Intl.DateTimeFormatOptions): string {
  if (!opts) return getDateOrderLocale();
  const hasTextual =
    (opts.month !== undefined &&
      opts.month !== "numeric" &&
      opts.month !== "2-digit") ||
    opts.weekday !== undefined ||
    opts.era !== undefined;
  if (hasTextual) return i18next.language;
  return getDateOrderLocale();
}

/** Format a time string from a Date */
export function formatTimePreferred(
  date: Date,
  opts?: Intl.DateTimeFormatOptions,
): string {
  return date.toLocaleTimeString(i18next.language, {
    ...opts,
    hour12: getHour12(),
  });
}

/** Format a date string from a Date, respecting user date-order preference */
export function formatDatePreferred(
  date: Date,
  opts?: Intl.DateTimeFormatOptions,
): string {
  return date.toLocaleDateString(getDateLocale(opts), opts);
}

/** Create an Intl.DateTimeFormat respecting both date and time preferences */
export function createDateTimeFormatter(
  opts: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const hasTime = opts.hour !== undefined || opts.minute !== undefined;
  const locale =
    opts.month || opts.day || opts.year
      ? getDateLocale(opts)
      : i18next.language;
  return new Intl.DateTimeFormat(locale, {
    ...opts,
    ...(hasTime ? { hour12: getHour12() } : {}),
  });
}

/** Format an absolute date+time string (used in tooltips, etc.) */
export function formatAbsoluteDateTime(date: Date): string {
  const timeZone = getResolvedTimezone();
  const datePart = formatDatePreferred(date, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
  const timePart = formatTimePreferred(date, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  return `${datePart} ${timePart}`;
}
