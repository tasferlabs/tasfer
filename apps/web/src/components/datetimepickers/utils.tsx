import { DateTime } from 'luxon';
import i18next from 'i18next';
import { getDateFormat, getHour12 } from '@/lib/dateTimePreferences';

export type DateFieldOrder = {
  fields: ('year' | 'month' | 'day')[];
  separator: string;
};

function detectSystemDateOrder(): DateFieldOrder {
  const formatter = new Intl.DateTimeFormat(i18next.language, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(2023, 11, 25));
  const fields: ('year' | 'month' | 'day')[] = [];
  let separator = '/';
  for (const part of parts) {
    if (part.type === 'year') fields.push('year');
    else if (part.type === 'month') fields.push('month');
    else if (part.type === 'day') fields.push('day');
    else if (part.type === 'literal' && fields.length === 1) separator = part.value;
  }
  if (fields.length !== 3) return { fields: ['year', 'month', 'day'], separator: '-' };
  return { fields, separator };
}

export function getDateFieldOrder(): DateFieldOrder {
  const format = getDateFormat();
  switch (format) {
    case 'MM/DD/YYYY':
      return { fields: ['month', 'day', 'year'], separator: '/' };
    case 'DD/MM/YYYY':
      return { fields: ['day', 'month', 'year'], separator: '/' };
    case 'YYYY-MM-DD':
      return { fields: ['year', 'month', 'day'], separator: '-' };
    default:
      return detectSystemDateOrder();
  }
}

/** Returns whether to use 12-hour format. Resolves 'system' to a concrete boolean. */
export function getResolved12h(): boolean {
  const hour12 = getHour12();
  if (hour12 !== undefined) return hour12;
  // Detect from system locale
  const formatted = new Intl.DateTimeFormat(i18next.language, {
    hour: 'numeric',
  }).resolvedOptions();
  return formatted.hour12 ?? false;
}

/** 0–23 → the 1–12 a 12-hour clock shows: 0 → 12, 13 → 1. */
export function to12Hour(hour24: number): number {
  return hour24 % 12 || 12;
}

/** 1–12 in the given half of the day → 0–23: 12 AM → 0, 12 PM → 12, 3 PM → 15. */
export function to24Hour(hour12: number, pm: boolean): number {
  return (hour12 % 12) + (pm ? 12 : 0);
}

/** The locale's own word for one half of the day: "AM"/"PM", "ص"/"م" in Arabic. */
export function getLocalizedDayPeriod(isAM: boolean, locale: string): string {
  const date = new Date(2000, 0, 1, isAM ? 9 : 15, 0);
  const parts = new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true }).formatToParts(date);
  return parts.find((p) => p.type === 'dayPeriod')?.value ?? (isAM ? 'AM' : 'PM');
}

/** Whether the locale writes the day period before the hour ("下午3:00") rather than after ("3:00 PM"). */
export function isDayPeriodBeforeHour(locale: string): boolean {
  const parts = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(
    new Date(2000, 0, 1, 15, 0)
  );
  const period = parts.findIndex((p) => p.type === 'dayPeriod');
  return period !== -1 && period < parts.findIndex((p) => p.type === 'hour');
}

export function toNumberOrNull(value: string) {
  const num = parseInt(value);
  if (isNaN(num)) {
    return null;
  }

  return num;
}

export function padValue(value: string, granularity: keyof DateTime<boolean>): string {
  switch (granularity) {
    case 'year':
      return value.padStart(4, '0');
    case 'month':
    case 'day':
    case 'hour':
    case 'minute':
    case 'second':
      return value.padStart(2, '0');
    default:
      throw new Error(`Unsupported granularity: ${granularity}`);
  }
}

export function getGranularityPlaceholder(granularity: keyof DateTime<boolean>) {
  switch (granularity) {
    case 'year':
      return 'yyyy';
    case 'month':
      return 'mm';
    case 'day':
      return 'dd';
    case 'hour':
      return 'hh';
    case 'minute':
      return 'mm';
    default:
      throw new Error(`Unsupported granularity: ${granularity}`);
  }
}

export function getSortingGranularity(granularity: keyof DateTime<boolean>) {
  switch (granularity) {
    case 'year':
      return 1;
    case 'month':
      return 2;
    case 'day':
      return 3;
    case 'hour':
      return 4;
    case 'minute':
      return 5;
    default:
      throw new Error(`Unsupported granularity: ${granularity}`);
  }
}

export function getGranularityFromSorting(sorting: number) {
  switch (sorting) {
    case 1:
      return 'year';
    case 2:
      return 'month';
    case 3:
      return 'day';
    case 4:
      return 'hour';
    case 5:
      return 'minute';
    default:
  }
}

export function getGranularityMaxValue(
  granularity: keyof DateTime<boolean>,
  year: number | null = null,
  month: number | null = null
) {
  switch (granularity) {
    case 'year':
      return 9999;
    case 'month':
      return 12;
    case 'day': {
      if (!year || !month) {
        throw new Error('Year and month are required');
      }
      return DateTime.local(year, month).daysInMonth || 31;
    }
    case 'hour':
      return 23;
    case 'minute':
      return 59;
    default:
      throw new Error(`Unsupported granularity: ${granularity}`);
  }
}

export function getGranularityMinValue(granularity: keyof DateTime<boolean>) {
  switch (granularity) {
    case 'year':
    case 'month':
    case 'day':
      return 1;
    case 'hour':
    case 'minute':
      return 0;
    default:
      throw new Error(`Unsupported granularity: ${granularity}`);
  }
}
export function getLuxon(iso: string, timezone: string) {
  if (!timezone) {
    throw new Error('Timezone is required');
  }
  const dateTime = DateTime.fromISO(iso, { zone: timezone });
  return dateTime;
}

export function plusGranularityValue(
  date: string | null,
  granularity: keyof DateTime<boolean>,
  amount: number,
  currentValue: string,
  flow = false,
  timezone: string
) {
  let value: number;
  if (!flow && date && getLuxon(date, timezone).isValid) {
    value = getLuxon(date, timezone)
      .plus({
        [granularity]: amount,
      })
      .get(granularity);
  } else {
    value = (toNumberOrNull(currentValue) || 0) + amount;
  }
  return padValue(value.toString(), granularity);
}

export function plusDatetime(iso: string, granularity: keyof DateTime<boolean>, amount: number, timezone: string) {
  return getLuxon(iso, timezone)
    .plus({
      [granularity]: amount,
    })
    .toISO();
}
