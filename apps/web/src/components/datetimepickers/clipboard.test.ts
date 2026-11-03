import { describe, expect, it } from 'vitest';
import { formatCopiedDateTime, parsePastedDateTime } from './clipboard';

const MDY = ['month', 'day', 'year'] as ('year' | 'month' | 'day')[];
const DMY = ['day', 'month', 'year'] as ('year' | 'month' | 'day')[];
const full = (year: string, month: string, day: string, hour = '', minute = '') => ({ year, month, day, hour, minute });

describe('parsePastedDateTime', () => {
  it('reads ISO with and without a time', () => {
    expect(parsePastedDateTime('2026-09-22T10:30:00.000+03:00', MDY, 'datetime')).toEqual(full('2026', '09', '22', '10', '30'));
    expect(parsePastedDateTime('2026-09-22 10:30', MDY, 'datetime')).toEqual(full('2026', '09', '22', '10', '30'));
    expect(parsePastedDateTime('2026-09-22', MDY, 'datetime')).toEqual(full('2026', '09', '22'));
  });

  it('reads numbers in the shown order', () => {
    expect(parsePastedDateTime('09/22/2026 14:05', MDY, 'datetime')).toEqual(full('2026', '09', '22', '14', '05'));
    expect(parsePastedDateTime('22/09/2026', DMY, 'date')).toEqual(full('2026', '09', '22'));
    expect(parsePastedDateTime('22.9.26', DMY, 'date')).toEqual(full('2026', '09', '22'));
  });

  it('reads year-first whatever the shown order', () => {
    expect(parsePastedDateTime('2026/09/22', DMY, 'date')).toEqual(full('2026', '09', '22'));
  });

  it('applies AM/PM', () => {
    expect(parsePastedDateTime('09/22/2026 3:00 PM', MDY, 'datetime')).toEqual(full('2026', '09', '22', '15', '00'));
    expect(parsePastedDateTime('09/22/2026 12:15am', MDY, 'datetime')).toEqual(full('2026', '09', '22', '00', '15'));
  });

  it('reads written-out English dates', () => {
    expect(parsePastedDateTime('Sep 22, 2026 3:00 PM', MDY, 'datetime')).toEqual(full('2026', '09', '22', '15', '00'));
    expect(parsePastedDateTime('September 22, 2026', MDY, 'date')).toEqual(full('2026', '09', '22'));
  });

  it('reads a time for a time-only picker', () => {
    expect(parsePastedDateTime('10:30', MDY, 'time')?.hour).toBe('10');
    expect(parsePastedDateTime('7 pm', MDY, 'time')).toMatchObject({ hour: '19', minute: '00' });
  });

  it('rejects what is not a date', () => {
    expect(parsePastedDateTime('hello', MDY, 'datetime')).toBeNull();
    expect(parsePastedDateTime('02/30/2026', MDY, 'date')).toBeNull();
    expect(parsePastedDateTime('13/22/2026', MDY, 'date')).toBeNull();
    expect(parsePastedDateTime('09/22/2026 25:00', MDY, 'datetime')).toBeNull();
    expect(parsePastedDateTime('Sep 22', MDY, 'date')).toBeNull();
  });
});

describe('formatCopiedDateTime', () => {
  it('writes the shown order and pastes back in', () => {
    const fields = full('2026', '09', '22', '14', '05');
    const text = formatCopiedDateTime(fields, DMY, '/', 'datetime');
    expect(text).toBe('22/09/2026 14:05');
    expect(parsePastedDateTime(text!, DMY, 'datetime')).toEqual(fields);
  });

  it('copies nothing for an incomplete value', () => {
    expect(formatCopiedDateTime(full('2026', '', '22'), MDY, '/', 'date')).toBeNull();
  });
});
