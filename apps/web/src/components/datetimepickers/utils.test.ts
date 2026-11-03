import { describe, expect, it } from 'vitest';
import { getLocalizedDayPeriod, isDayPeriodBeforeHour, to12Hour, to24Hour } from './utils';

describe('12-hour clock mapping', () => {
  it('shows 0–23 as 1–12', () => {
    expect(to12Hour(0)).toBe(12);
    expect(to12Hour(1)).toBe(1);
    expect(to12Hour(11)).toBe(11);
    expect(to12Hour(12)).toBe(12);
    expect(to12Hour(16)).toBe(4);
    expect(to12Hour(23)).toBe(11);
  });

  it('reads 1–12 back in the chosen half', () => {
    expect(to24Hour(12, false)).toBe(0);
    expect(to24Hour(12, true)).toBe(12);
    expect(to24Hour(4, true)).toBe(16);
    expect(to24Hour(4, false)).toBe(4);
    // A typed "0" or "00" is the 12 of that half.
    expect(to24Hour(0, false)).toBe(0);
    expect(to24Hour(0, true)).toBe(12);
  });

  it('round-trips every hour', () => {
    for (let hour = 0; hour < 24; hour++) {
      expect(to24Hour(to12Hour(hour), hour >= 12)).toBe(hour);
    }
  });
});

describe('day period', () => {
  it("uses the locale's own words", () => {
    expect(getLocalizedDayPeriod(true, 'en')).toBe('AM');
    expect(getLocalizedDayPeriod(false, 'en')).toBe('PM');
    expect(getLocalizedDayPeriod(true, 'ar')).toBe('ص');
    expect(getLocalizedDayPeriod(false, 'ar')).toBe('م');
  });

  it('follows the locale for which side of the hour it goes', () => {
    expect(isDayPeriodBeforeHour('en')).toBe(false);
    expect(isDayPeriodBeforeHour('ar')).toBe(false);
    expect(isDayPeriodBeforeHour('zh')).toBe(true);
    expect(isDayPeriodBeforeHour('ko')).toBe(true);
  });
});
