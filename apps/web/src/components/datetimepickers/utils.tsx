import { DateTime } from 'luxon';

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
