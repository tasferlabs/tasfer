import { DateTime } from 'luxon';

/** Padded field strings, the same shape the picker keeps in state. */
export type DateTimeFields = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
};

type DateField = 'year' | 'month' | 'day';

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** `withTime` false leaves hour and minute empty so the picker keeps its own. */
function toFields(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  withTime = true,
): DateTimeFields | null {
  if (year < 1 || year > 9999 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  // Rejects day 31 in a 30-day month and the like.
  if (!DateTime.local(year, month, day).isValid) return null;
  return {
    year: pad(year, 4),
    month: pad(month, 2),
    day: pad(day, 2),
    hour: withTime ? pad(hour, 2) : '',
    minute: withTime ? pad(minute, 2) : '',
  };
}

const DAY_PERIOD = /(?<![a-z])([ap]\.?m\.?)(?![a-z])/i;

/** 12 PM → 12, 12 AM → 0, 3 PM → 15. Null for an hour that can't carry AM/PM. */
function applyDayPeriod(hour: number, text: string): number | null {
  const period = DAY_PERIOD.exec(text)?.[1].toLowerCase();
  if (!period) return hour;
  if (hour < 1 || hour > 12) return null;
  return (hour % 12) + (period.startsWith('p') ? 12 : 0);
}

/**
 * Reads a pasted date and/or time. Accepts ISO (`2026-09-22T10:30`), numbers
 * in the order the picker shows them (`09/22/2026 10:30`), a year-first form
 * whatever the order, and written-out English dates (`Sep 22, 2026 3:00 PM`).
 * For a time-only picker it reads `10:30` / `3 PM`. Null when it isn't one.
 */
export function parsePastedDateTime(
  raw: string,
  order: DateField[],
  type: 'date' | 'datetime' | 'time',
): DateTimeFields | null {
  const text = raw.trim();
  if (!text) return null;

  if (type === 'time') {
    const match = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap]\.?m\.?)?$/i.exec(text);
    if (!match || (!match[2] && !match[3])) return null;
    const hour = applyDayPeriod(Number(match[1]), text);
    if (hour === null) return null;
    return toFields(2000, 1, 1, hour, Number(match[2] ?? 0));
  }

  const hasTime = /\d:\d/.test(text) || DAY_PERIOD.test(text);

  // ISO, with `T` or a space between date and time; keeps the written wall time.
  const iso = DateTime.fromISO(text, { setZone: true });
  const sql = iso.isValid ? iso : DateTime.fromSQL(text, { setZone: true });
  if (sql.isValid) return toFields(sql.year, sql.month, sql.day, sql.hour, sql.minute, hasTime);

  // Written-out month names: let the platform parser read them.
  if (/\p{L}/u.test(text.replace(DAY_PERIOD, ''))) {
    if (!/\d{4}/.test(text)) return null;
    const date = new Date(text);
    if (isNaN(date.getTime())) return null;
    return toFields(date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), hasTime);
  }

  const numbers = text.match(/\d+/g);
  if (!numbers || numbers.length < 3 || numbers.length > 6) return null;

  const dateOrder: DateField[] = numbers[0].length === 4 ? ['year', 'month', 'day'] : order;
  const parts: Record<DateField, number> = { year: 0, month: 0, day: 0 };
  dateOrder.forEach((field, i) => {
    parts[field] = Number(numbers[i]);
  });
  const yearDigits = numbers[dateOrder.indexOf('year')].length;
  if (yearDigits === 2) parts.year += 2000;
  else if (yearDigits !== 4) return null;

  const hour = applyDayPeriod(Number(numbers[3] ?? 0), text);
  if (hour === null) return null;
  return toFields(parts.year, parts.month, parts.day, hour, Number(numbers[4] ?? 0), hasTime);
}

/** The picker's value as text in the order it is shown, which pastes back in. */
export function formatCopiedDateTime(
  fields: DateTimeFields,
  order: DateField[],
  separator: string,
  type: 'date' | 'datetime' | 'time',
): string | null {
  const time = fields.hour && fields.minute ? `${fields.hour}:${fields.minute}` : null;
  if (type === 'time') return time;
  if (!fields.year || !fields.month || !fields.day) return null;
  const date = order.map((field) => fields[field]).join(separator);
  return type === 'datetime' && time ? `${date} ${time}` : date;
}
