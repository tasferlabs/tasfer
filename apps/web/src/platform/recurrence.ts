import { DateTime } from "luxon";

/**
 * Repeating events.
 *
 * A series is one page whose `recurrence` field holds a rule in RFC 5545 RRULE
 * shape, plus a `TZID` part of our own naming the zone the rule repeats in:
 *
 *   FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;UNTIL=20261231T225959Z;TZID=Europe/Berlin
 *
 * The zone belongs to the rule, not to whoever is looking: a 09:00 standup made
 * in Berlin stays at 09:00 Berlin time across daylight-saving changes, for
 * every viewer. The page's `scheduled_at` is the first occurrence (DTSTART).
 *
 * Occurrences are never stored. They are worked out for the visible range on
 * every read, so a series that never ends costs nothing. An occurrence that
 * someone changed or cancelled is an "exception": a page of its own pointing at
 * the series through `recurrence_id`, keyed by the start the rule gave it
 * (`recurrence_start`, RFC 5545's RECURRENCE-ID).
 *
 * Unknown parts are kept on a round trip so a rule written by a newer build is
 * not narrowed by an older one that edits it.
 */

export type RecurrenceFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** RFC 5545 weekday codes, Monday first (Luxon's weekday 1..7 order). */
export const WEEKDAY_CODES = [
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
  "SU",
] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** Every Nth period. Always ≥ 1. */
  interval: number;
  /**
   * WEEKLY: the weekdays it falls on (empty → DTSTART's weekday).
   * MONTHLY: at most one entry with an ordinal — `{ n: 2, day: "TU" }` is the
   * second Tuesday, `{ n: -1, day: "FR" }` the last Friday.
   */
  byDay: { n: number | null; day: WeekdayCode }[];
  /** MONTHLY: day of the month (negative counts from the end). */
  byMonthDay: number | null;
  /** Stop after this many occurrences, DTSTART included. */
  count: number | null;
  /** Last allowed start, as a UTC ISO instant. */
  until: string | null;
  /** IANA zone the rule repeats in. */
  tzid: string;
  /** Parts this build does not understand, kept verbatim. */
  extra: string[];
}

const FREQS: readonly RecurrenceFreq[] = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
];

/** Parse a stored rule. Returns null when it is not a rule this build can expand. */
export function parseRecurrence(
  raw: string | null | undefined,
): RecurrenceRule | null {
  if (!raw) return null;
  const rule: RecurrenceRule = {
    freq: "DAILY",
    interval: 1,
    byDay: [],
    byMonthDay: null,
    count: null,
    until: null,
    tzid: "UTC",
    extra: [],
  };
  let sawFreq = false;
  for (const part of raw.replace(/^RRULE:/, "").split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = (eq < 0 ? part : part.slice(0, eq)).toUpperCase();
    const value = eq < 0 ? "" : part.slice(eq + 1);
    switch (key) {
      case "FREQ": {
        const freq = value.toUpperCase() as RecurrenceFreq;
        if (!FREQS.includes(freq)) return null;
        rule.freq = freq;
        sawFreq = true;
        break;
      }
      case "INTERVAL": {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 1) rule.interval = n;
        break;
      }
      case "BYDAY": {
        for (const token of value.split(",")) {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(
            token.trim(),
          );
          if (!m) continue;
          rule.byDay.push({
            n: m[1] ? Number(m[1]) : null,
            day: m[2].toUpperCase() as WeekdayCode,
          });
        }
        break;
      }
      case "BYMONTHDAY": {
        const n = Number(value.split(",")[0]);
        if (Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31) {
          rule.byMonthDay = n;
        }
        break;
      }
      case "COUNT": {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 1) rule.count = n;
        break;
      }
      case "UNTIL": {
        const until = parseUntil(value);
        if (until) rule.until = until;
        break;
      }
      case "TZID":
        if (DateTime.local().setZone(value).isValid) rule.tzid = value;
        break;
      default:
        rule.extra.push(part);
    }
  }
  return sawFreq ? rule : null;
}

/** Serialize a rule back into its stored shape. */
export function formatRecurrence(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay.length > 0) {
    parts.push(
      `BYDAY=${rule.byDay.map((d) => `${d.n ?? ""}${d.day}`).join(",")}`,
    );
  }
  if (rule.byMonthDay !== null) parts.push(`BYMONTHDAY=${rule.byMonthDay}`);
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== null) parts.push(`UNTIL=${formatUntil(rule.until)}`);
  parts.push(...rule.extra);
  parts.push(`TZID=${rule.tzid}`);
  return parts.join(";");
}

function parseUntil(value: string): string | null {
  // 20261231T225959Z, 20261231T225959 (floating, read as UTC), or 20261231.
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = "23", mi = "59", s = "59"] = m;
  const dt = DateTime.utc(+y, +mo, +d, +h, +mi, +s);
  return dt.isValid ? dt.toISO({ suppressMilliseconds: true }) : null;
}

function formatUntil(iso: string): string {
  return DateTime.fromISO(iso, { zone: "utc" }).toFormat(
    "yyyyMMdd'T'HHmmss'Z'",
  );
}

/** Normalize an instant to the UTC shape stored in `recurrence_start`. */
export function occurrenceKey(iso: string): string {
  return new Date(iso).toISOString();
}

/**
 * The page id of the exception for one occurrence. Derived rather than random,
 * so two devices that change the same occurrence while offline end up writing
 * to the same page instead of making two.
 */
export function exceptionPageId(
  seriesId: string,
  originalStart: string,
): string {
  const stamp = DateTime.fromISO(occurrenceKey(originalStart), {
    zone: "utc",
  }).toFormat("yyyyMMdd'T'HHmmss");
  return `${seriesId}-${stamp}`;
}

/** Safety stop for pathological rules (and a cap on any single range read). */
const MAX_STEPS = 100_000;

/**
 * Every occurrence start of a series that falls in [rangeStart, rangeEnd], as
 * UTC ISO instants in ascending order. `dtstart` is the series' first start.
 *
 * Occurrences are generated in wall time in the rule's zone, so the clock time
 * holds across daylight-saving changes. A wall time that does not exist on a
 * given day (inside a spring-forward gap) moves forward, as Luxon resolves it.
 * Like RFC 5545, a monthly rule on the 31st skips months without one.
 */
export function expandOccurrences(
  dtstart: string,
  rule: RecurrenceRule,
  rangeStart: string,
  rangeEnd: string,
): string[] {
  const start = DateTime.fromISO(dtstart).setZone(rule.tzid);
  if (!start.isValid) return [];
  const lo = DateTime.fromISO(rangeStart).toMillis();
  let hi = DateTime.fromISO(rangeEnd).toMillis();
  if (rule.until) hi = Math.min(hi, DateTime.fromISO(rule.until).toMillis());
  if (hi < start.toMillis()) return [];

  const out: string[] = [];
  let emitted = 0;
  // Without a COUNT nothing earlier in the series matters, so start a little
  // before the range instead of walking from DTSTART.
  let period = rule.count === null ? skipPeriods(start, rule, lo) : 0;

  for (let step = 0; step < MAX_STEPS; step++, period++) {
    const candidates = periodCandidates(start, rule, period);
    if (candidates === null) break;
    let pastEnd = false;
    for (const c of candidates) {
      const ms = c.toMillis();
      if (ms < start.toMillis()) continue;
      if (ms > hi) {
        pastEnd = true;
        break;
      }
      emitted++;
      if (ms >= lo) out.push(c.toUTC().toISO()!);
      if (rule.count !== null && emitted >= rule.count) return out;
    }
    if (pastEnd) break;
  }
  return out;
}

/** How many whole periods can be skipped before reaching `lo`. */
function skipPeriods(
  start: DateTime,
  rule: RecurrenceRule,
  lo: number,
): number {
  const target = DateTime.fromMillis(lo, { zone: rule.tzid });
  if (target <= start) return 0;
  let units: number;
  switch (rule.freq) {
    case "DAILY":
      units = target.diff(start, "days").days;
      break;
    case "WEEKLY":
      units = target.diff(start.startOf("week"), "weeks").weeks;
      break;
    case "MONTHLY":
      units = target.diff(start.startOf("month"), "months").months;
      break;
    case "YEARLY":
      units = target.diff(start.startOf("year"), "years").years;
      break;
  }
  // One period of slack on each side of the rounding.
  return Math.max(0, Math.floor(units / rule.interval) - 1);
}

/**
 * The candidate starts in the `period`-th period after DTSTART's, sorted.
 * Null means no later period can produce anything (out of representable time).
 */
function periodCandidates(
  start: DateTime,
  rule: RecurrenceRule,
  period: number,
): DateTime[] | null {
  const n = period * rule.interval;
  const time = {
    hour: start.hour,
    minute: start.minute,
    second: start.second,
    millisecond: 0,
  };
  const at = (d: DateTime) => d.set(time);

  switch (rule.freq) {
    case "DAILY": {
      const d = start.plus({ days: n });
      return d.isValid ? [d] : null;
    }
    case "WEEKLY": {
      const weekStart = start.startOf("week").plus({ weeks: n });
      if (!weekStart.isValid) return null;
      const days = rule.byDay.length
        ? [...new Set(rule.byDay.map((d) => WEEKDAY_CODES.indexOf(d.day) + 1))]
        : [start.weekday];
      return days
        .sort((a, b) => a - b)
        .map((wd) => at(weekStart.plus({ days: wd - 1 })));
    }
    case "MONTHLY": {
      const month = start.startOf("month").plus({ months: n });
      if (!month.isValid) return null;
      const ordinal = rule.byDay.find((d) => d.n !== null);
      if (ordinal) {
        const day = nthWeekdayOfMonth(month, ordinal.day, ordinal.n!);
        return day ? [at(day)] : [];
      }
      const dom = rule.byMonthDay ?? start.day;
      const len = month.daysInMonth!;
      const day = dom > 0 ? dom : len + dom + 1;
      return day >= 1 && day <= len ? [at(month.set({ day }))] : [];
    }
    case "YEARLY": {
      const year = start.startOf("year").plus({ years: n });
      if (!year.isValid) return null;
      const month = year.set({ month: start.month });
      // Feb 29 only exists in leap years; RFC 5545 skips the others.
      return start.day <= month.daysInMonth!
        ? [at(month.set({ day: start.day }))]
        : [];
    }
  }
}

function nthWeekdayOfMonth(
  month: DateTime,
  day: WeekdayCode,
  n: number,
): DateTime | null {
  const wd = WEEKDAY_CODES.indexOf(day) + 1;
  const len = month.daysInMonth!;
  if (n > 0) {
    const first = month.set({ day: 1 });
    const offset = (wd - first.weekday + 7) % 7;
    const d = 1 + offset + (n - 1) * 7;
    return d <= len ? month.set({ day: d }) : null;
  }
  const last = month.set({ day: len });
  const offset = (last.weekday - wd + 7) % 7;
  const d = len - offset + (n + 1) * 7;
  return d >= 1 ? month.set({ day: d }) : null;
}

/**
 * The rule ending just before `occurrenceStart`, for "this and following":
 * the old series keeps everything earlier and a new series takes over.
 */
export function endRuleBefore(
  rule: RecurrenceRule,
  occurrenceStart: string,
): RecurrenceRule {
  const until = DateTime.fromISO(occurrenceStart, { zone: "utc" })
    .minus({ seconds: 1 })
    .toISO({ suppressMilliseconds: true })!;
  return { ...rule, count: null, until };
}

/**
 * How many occurrences of a COUNT-limited series come before `occurrenceStart`,
 * so the follow-on series can be given only what is left.
 */
export function occurrencesBefore(
  dtstart: string,
  rule: RecurrenceRule,
  occurrenceStart: string,
): number {
  const before = DateTime.fromISO(occurrenceStart).minus({ milliseconds: 1 });
  if (before < DateTime.fromISO(dtstart)) return 0;
  return expandOccurrences(dtstart, rule, dtstart, before.toISO()!).length;
}

/**
 * Where an occurrence's key lands when its whole series moves from `oldStart`
 * to `newStart`: the same number of calendar days later, at the new start's
 * clock time, both in the rule's zone. Lets per-occurrence changes and notes
 * follow the series instead of being left behind on dates it no longer hits.
 */
export function shiftOccurrenceKey(
  key: string,
  oldStart: string,
  newStart: string,
  tzid: string,
): string {
  const from = DateTime.fromISO(oldStart).setZone(tzid);
  const to = DateTime.fromISO(newStart).setZone(tzid);
  const days = Math.round(
    to.startOf("day").diff(from.startOf("day"), "days").days,
  );
  return DateTime.fromISO(key)
    .setZone(tzid)
    .plus({ days })
    .set({
      hour: to.hour,
      minute: to.minute,
      second: to.second,
      millisecond: 0,
    })
    .toUTC()
    .toISO()!;
}

/**
 * The rule after its series' first start moves from `oldStart` to `newStart`,
 * so the parts pinned to a date move along: weekly days shift by the same
 * number of days, and a monthly date or "nth weekday" is taken from the new
 * start. Daily and yearly rules follow the start on their own.
 */
export function shiftRule(
  rule: RecurrenceRule,
  oldStart: string,
  newStart: string,
): RecurrenceRule {
  const from = DateTime.fromISO(oldStart).setZone(rule.tzid);
  const to = DateTime.fromISO(newStart).setZone(rule.tzid);
  const days = Math.round(
    to.startOf("day").diff(from.startOf("day"), "days").days,
  );
  if (days === 0) return rule;
  if (rule.freq === "WEEKLY" && rule.byDay.length > 0) {
    const byDay = rule.byDay.map((d) => ({
      n: d.n,
      day: WEEKDAY_CODES[(((WEEKDAY_CODES.indexOf(d.day) + days) % 7) + 7) % 7],
    }));
    return { ...rule, byDay };
  }
  if (rule.freq === "MONTHLY") {
    const ordinal = rule.byDay.find((d) => d.n !== null);
    if (ordinal) {
      return { ...rule, byDay: [monthlyOrdinalOf(to, ordinal.n! < 0)] };
    }
    if (rule.byMonthDay !== null) {
      const last = rule.byMonthDay < 0 && to.day === to.daysInMonth;
      return { ...rule, byMonthDay: last ? -1 : to.day };
    }
  }
  return rule;
}

/** "The 2nd Tuesday" (or with `fromEnd`, "the last Tuesday") naming `date`. */
export function monthlyOrdinalOf(
  date: DateTime,
  fromEnd: boolean,
): { n: number; day: WeekdayCode } {
  const day = WEEKDAY_CODES[date.weekday - 1];
  if (fromEnd) {
    return { n: -(Math.floor((date.daysInMonth! - date.day) / 7) + 1), day };
  }
  return { n: Math.floor((date.day - 1) / 7) + 1, day };
}

/**
 * A rule from outside (an imported file) in its stored shape, or null when it
 * is not one this build can expand. Imports go through here so a malformed
 * rule never reaches the op log.
 */
export function normalizeRecurrence(
  raw: string | null | undefined,
): string | null {
  const rule = parseRecurrence(raw);
  return rule ? formatRecurrence(rule) : null;
}
