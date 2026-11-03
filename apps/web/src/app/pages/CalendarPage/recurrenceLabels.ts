import type { TFunction } from "i18next";
import i18next from "i18next";
import { DateTime, type WeekdayNumbers } from "luxon";
import {
  WEEKDAY_CODES,
  formatRecurrence,
  monthlyOrdinalOf,
  parseRecurrence,
  type RecurrenceRule,
  type WeekdayCode,
} from "@/platform/recurrence";

/**
 * Words for repeating events, and the preset rules the repeat picker offers.
 * Every preset is read off the event's own start, so "Every week on Tuesday"
 * names the day the event is actually on.
 */

/** A weekday code's name in the UI language (Monday-first, as Luxon numbers). */
export function weekdayName(
  day: WeekdayCode,
  width: "long" | "short" = "long",
): string {
  return DateTime.fromObject(
    { weekday: (WEEKDAY_CODES.indexOf(day) + 1) as WeekdayNumbers },
    { locale: i18next.language },
  ).toLocaleString({ weekday: width });
}

function weekdayList(days: WeekdayCode[]): string {
  const names = [...days]
    .sort((a, b) => WEEKDAY_CODES.indexOf(a) - WEEKDAY_CODES.indexOf(b))
    .map((d) => weekdayName(d));
  return new Intl.ListFormat(i18next.language, {
    style: "long",
    type: "conjunction",
  }).format(names);
}

function nthLabel(n: number, t: TFunction): string {
  switch (n) {
    case 1:
      return t("calendar.repeat.nth.1", "first");
    case 2:
      return t("calendar.repeat.nth.2", "second");
    case 3:
      return t("calendar.repeat.nth.3", "third");
    case 4:
      return t("calendar.repeat.nth.4", "fourth");
    default:
      return t("calendar.repeat.nth.last", "last");
  }
}

const WORK_WEEK: readonly WeekdayCode[] = ["MO", "TU", "WE", "TH", "FR"];

function isWorkWeek(rule: RecurrenceRule): boolean {
  const days = new Set(rule.byDay.map((d) => d.day));
  return (
    rule.freq === "WEEKLY" &&
    rule.interval === 1 &&
    days.size === WORK_WEEK.length &&
    WORK_WEEK.every((d) => days.has(d))
  );
}

/** How the rule repeats, without when it ends ("Every 2 weeks on Monday"). */
export function describePattern(
  rule: RecurrenceRule,
  start: string,
  t: TFunction,
): string {
  const first = DateTime.fromISO(start).setZone(rule.tzid);
  const count = rule.interval;
  switch (rule.freq) {
    case "DAILY":
      return t("calendar.repeat.pattern.daily", {
        count,
        defaultValue_one: "Every day",
        defaultValue_other: "Every {{count, number}} days",
      });
    case "WEEKLY": {
      if (isWorkWeek(rule)) {
        return t("calendar.repeat.pattern.weekdays", "Every weekday");
      }
      const days = rule.byDay.length
        ? rule.byDay.map((d) => d.day)
        : [WEEKDAY_CODES[first.weekday - 1]];
      return t("calendar.repeat.pattern.weekly", {
        // Names and dates, rendered as text by React: no HTML escaping.
        interpolation: { escapeValue: false },
        count,
        days: weekdayList(days),
        defaultValue_one: "Every week on {{days}}",
        defaultValue_other: "Every {{count, number}} weeks on {{days}}",
      });
    }
    case "MONTHLY": {
      const ordinal = rule.byDay.find((d) => d.n !== null);
      if (ordinal) {
        return t("calendar.repeat.pattern.monthlyWeekday", {
          // Names and dates, rendered as text by React: no HTML escaping.
          interpolation: { escapeValue: false },
          count,
          nth: nthLabel(ordinal.n!, t),
          weekday: weekdayName(ordinal.day),
          defaultValue_one: "Every month on the {{nth}} {{weekday}}",
          defaultValue_other:
            "Every {{count, number}} months on the {{nth}} {{weekday}}",
        });
      }
      const day = rule.byMonthDay ?? first.day;
      if (day < 0) {
        return t("calendar.repeat.pattern.monthlyLastDay", {
          count,
          defaultValue_one: "Every month on the last day",
          defaultValue_other: "Every {{count, number}} months on the last day",
        });
      }
      return t("calendar.repeat.pattern.monthlyDay", {
        count,
        day,
        defaultValue_one: "Every month on day {{day}}",
        defaultValue_other: "Every {{count, number}} months on day {{day}}",
      });
    }
    case "YEARLY":
      return t("calendar.repeat.pattern.yearly", {
        // Names and dates, rendered as text by React: no HTML escaping.
        interpolation: { escapeValue: false },
        count,
        date: first
          .setLocale(i18next.language)
          .toLocaleString({ month: "long", day: "numeric" }),
        defaultValue_one: "Every year on {{date}}",
        defaultValue_other: "Every {{count, number}} years on {{date}}",
      });
  }
}

/** The whole rule in words, with its end ("Every day, 5 times"). */
export function describeRecurrence(
  raw: string | null | undefined,
  start: string,
  t: TFunction,
): string | null {
  const rule = parseRecurrence(raw);
  if (!rule) return null;
  const pattern = describePattern(rule, start, t);
  if (rule.count !== null) {
    return t("calendar.repeat.withEndCount", {
      // Names and dates, rendered as text by React: no HTML escaping.
      interpolation: { escapeValue: false },
      pattern,
      count: rule.count,
      defaultValue_one: "{{pattern}}, once",
      defaultValue_other: "{{pattern}}, {{count, number}} times",
    });
  }
  if (rule.until !== null) {
    return t("calendar.repeat.withEndDate", {
      // Names and dates, rendered as text by React: no HTML escaping.
      interpolation: { escapeValue: false },
      pattern,
      date: DateTime.fromISO(rule.until)
        .setZone(rule.tzid)
        .setLocale(i18next.language)
        .toLocaleString(DateTime.DATE_MED),
      defaultValue: "{{pattern}}, until {{date}}",
    });
  }
  return pattern;
}

/** A new rule with nothing but a frequency, repeating in `tzid`. */
export function baseRule(
  freq: RecurrenceRule["freq"],
  tzid: string,
): RecurrenceRule {
  return {
    freq,
    interval: 1,
    byDay: [],
    byMonthDay: null,
    count: null,
    until: null,
    tzid,
    extra: [],
  };
}

export interface RepeatPreset {
  key: string;
  rule: string;
}

/**
 * The picker's one-tap choices for an event starting at `start`, shown in
 * `tzid`. A rule's end is kept off presets: picking one replaces only how it
 * repeats, so "until" or "N times" set in Custom stays put (see `withEnd`).
 */
export function repeatPresets(start: string, tzid: string): RepeatPreset[] {
  const first = DateTime.fromISO(start).setZone(tzid);
  const day = WEEKDAY_CODES[first.weekday - 1];
  const weekly = baseRule("WEEKLY", tzid);
  weekly.byDay = [{ n: null, day }];
  const weekdays = baseRule("WEEKLY", tzid);
  weekdays.byDay = WORK_WEEK.map((d) => ({ n: null, day: d }));
  const monthlyDay = baseRule("MONTHLY", tzid);
  monthlyDay.byMonthDay = first.day;
  const monthlyNth = baseRule("MONTHLY", tzid);
  // The 5th weekday doesn't come every month; name it as "the last" instead.
  const nth = monthlyOrdinalOf(first, false);
  monthlyNth.byDay = [nth.n > 4 ? monthlyOrdinalOf(first, true) : nth];

  const presets: [string, RecurrenceRule][] = [
    ["daily", baseRule("DAILY", tzid)],
    ["weekdays", weekdays],
    ["weekly", weekly],
    ["monthlyDay", monthlyDay],
    ["monthlyNth", monthlyNth],
    ["yearly", baseRule("YEARLY", tzid)],
  ];
  // The last day of a month also gets a "last day" choice; the 29th–31st
  // otherwise skip the months that don't have them.
  if (first.day === first.daysInMonth && first.day > 28) {
    const lastDay = baseRule("MONTHLY", tzid);
    lastDay.byMonthDay = -1;
    presets.splice(4, 0, ["monthlyLastDay", lastDay]);
  }
  return presets.map(([key, rule]) => ({ key, rule: formatRecurrence(rule) }));
}

/** `pattern` with `ends`'s end (count or until) carried over. */
export function withEnd(pattern: string, ends: string | null): string {
  const p = parseRecurrence(pattern);
  const e = parseRecurrence(ends);
  if (!p || !e) return pattern;
  return formatRecurrence({ ...p, count: e.count, until: e.until });
}

/** Whether two stored rules repeat the same way, ignoring when they end. */
export function samePattern(a: string | null, b: string | null): boolean {
  const pa = parseRecurrence(a);
  const pb = parseRecurrence(b);
  if (!pa || !pb) return false;
  return (
    formatRecurrence({ ...pa, count: null, until: null }) ===
    formatRecurrence({ ...pb, count: null, until: null })
  );
}
