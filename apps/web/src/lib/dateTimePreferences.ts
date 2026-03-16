import i18next from "i18next";

// ── Types ──

export type TimeFormat = "12h" | "24h" | "system";
export type DateFormat = "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD" | "system";
/** 0 = Sunday, 1 = Monday, 6 = Saturday */
export type WeekStart = 0 | 1 | 6;

// ── Storage ──

const TIME_FORMAT_KEY = "timeFormat";
const DATE_FORMAT_KEY = "dateFormat";
const WEEK_START_KEY = "weekStart";

export function getTimeFormat(): TimeFormat {
  if (typeof window === "undefined") return "system";
  return (localStorage.getItem(TIME_FORMAT_KEY) as TimeFormat) || "system";
}

export function setTimeFormat(format: TimeFormat) {
  localStorage.setItem(TIME_FORMAT_KEY, format);
}

export function getDateFormat(): DateFormat {
  if (typeof window === "undefined") return "system";
  return (localStorage.getItem(DATE_FORMAT_KEY) as DateFormat) || "system";
}

export function setDateFormat(format: DateFormat) {
  localStorage.setItem(DATE_FORMAT_KEY, format);
}

export function getWeekStart(): WeekStart {
  if (typeof window === "undefined") return 1;
  const stored = localStorage.getItem(WEEK_START_KEY);
  if (stored === "0" || stored === "1" || stored === "6") return Number(stored) as WeekStart;
  return 1; // default Monday
}

export function setWeekStart(day: WeekStart) {
  localStorage.setItem(WEEK_START_KEY, String(day));
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
    (opts.month !== undefined && opts.month !== "numeric" && opts.month !== "2-digit") ||
    (opts.weekday !== undefined) ||
    (opts.era !== undefined);
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
  const locale = opts.month || opts.day || opts.year ? getDateLocale(opts) : i18next.language;
  return new Intl.DateTimeFormat(locale, {
    ...opts,
    ...(hasTime ? { hour12: getHour12() } : {}),
  });
}

/** Format an absolute date+time string (used in tooltips, etc.) */
export function formatAbsoluteDateTime(date: Date): string {
  const datePart = formatDatePreferred(date, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timePart = formatTimePreferred(date, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${datePart} ${timePart}`;
}
