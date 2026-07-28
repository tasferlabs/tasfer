import { DateTime } from "luxon";
import type { ICalendarPage } from "../../api/pages.api";
import {
  formatTimePreferred,
  formatDatePreferred,
  createDateTimeFormatter,
  getWeekStart,
  getResolvedTimezone,
} from "@/lib/dateTimePreferences";

// ── Constants ──

export const HOUR_HEIGHT = 60;
export const TOTAL_HOURS = 24;
export const SNAP_MINUTES = 15;
export const MIN_DRAG_MINUTES = 15;
export const SNAP_PX = (SNAP_MINUTES / 60) * HOUR_HEIGHT;

export type ViewMode = "day" | "week";

export interface CalendarInterval {
  id: string;
  startMinutes: number;
  duration: number;
}

export interface CalendarEventLayout {
  lane: number;
  laneCount: number;
}

const MIN_EVENT_HEIGHT_MINUTES = 20;

// ── Display time zone ──
//
// The grid works in "wall dates": plain Dates whose local components carry the
// wall-clock time of the preferred display zone (Settings → Date & Time).
// Stored instants are converted at the boundary — zonedWallDate on the way in,
// wallDateToUtcIso on the way out — so the grid's local-Date math (setHours,
// getDay, …) needs no zone awareness. With the default "system" preference
// every conversion is the identity.

/** Stored instant → wall date in the display zone. */
export function zonedWallDate(iso: string): Date {
  const d = DateTime.fromISO(iso).setZone(getResolvedTimezone());
  return new Date(
    d.year,
    d.month - 1,
    d.day,
    d.hour,
    d.minute,
    d.second,
    d.millisecond,
  );
}

/** Wall date in the display zone → UTC ISO instant for storage. */
export function wallDateToUtcIso(date: Date): string {
  return DateTime.fromJSDate(date)
    .setZone(getResolvedTimezone(), { keepLocalTime: true })
    .toUTC()
    .toISO()!;
}

/** Wall-date epoch ms → the instant epoch ms it represents in the display zone. */
export function wallMsToInstantMs(ms: number): number {
  return DateTime.fromMillis(ms)
    .setZone(getResolvedTimezone(), { keepLocalTime: true })
    .toMillis();
}

/** The current moment as a wall date in the display zone. */
export function wallNow(): Date {
  return zonedWallDate(new Date().toISOString());
}

// ── Helpers ──

export function formatHour(hour: number): string {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return formatTimePreferred(date, { hour: "numeric" });
}

export function formatDate(date: Date): string {
  return formatDatePreferred(date, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function formatWeekRange(date: Date): string {
  const { start, end } = getWeekRange(date);
  const formatter = createDateTimeFormatter({
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return formatter.formatRange(new Date(start), new Date(end));
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function getDayRange(date: Date): { start: number; end: number } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start: start.getTime(), end: end.getTime() };
}

export function getWeekRange(date: Date): { start: number; end: number } {
  const d = new Date(date);
  const dow = d.getDay(); // 0=Sun
  const ws = getWeekStart();
  const diff = (dow - ws + 7) % 7;
  const first = new Date(d);
  first.setDate(d.getDate() - diff);
  first.setHours(0, 0, 0, 0);
  const last = new Date(first);
  last.setDate(first.getDate() + 6);
  last.setHours(23, 59, 59, 999);
  return { start: first.getTime(), end: last.getTime() };
}

export function getWeekDays(date: Date): Date[] {
  const { start } = getWeekRange(date);
  const first = new Date(start);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(first);
    d.setDate(first.getDate() + i);
    return d;
  });
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const date = new Date();
  date.setHours(h, m, 0, 0);
  if (m === 0) {
    return formatTimePreferred(date, { hour: "numeric" });
  }
  return formatTimePreferred(date, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatEventTime(
  timestamp: string,
  duration?: number | null,
): string {
  const date = zonedWallDate(timestamp);
  const startMin = date.getHours() * 60 + date.getMinutes();
  if (duration) {
    return formatTimeRange(startMin, startMin + duration);
  }
  return formatTime(startMin);
}

export function formatTimeRange(startMinutes: number, endMinutes: number): string {
  const start = new Date();
  start.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
  const end = new Date();
  end.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);
  const formatter = createDateTimeFormatter({
    hour: "numeric",
    minute: "2-digit",
  });
  return formatter.formatRange(start, end);
}

export function pxToMinutes(px: number): number {
  const raw = (px / HOUR_HEIGHT) * 60;
  return Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
}

export function snapPx(px: number): number {
  return Math.round(px / SNAP_PX) * SNAP_PX;
}

export function pageToStartMin(page: ICalendarPage): number {
  const d = zonedWallDate(page.scheduledAt);
  return d.getHours() * 60 + d.getMinutes();
}

export function layoutCalendarIntervals(
  intervals: CalendarInterval[],
): Map<string, CalendarEventLayout> {
  const sorted = intervals
    .map((interval) => ({
      ...interval,
      endMinutes:
        interval.startMinutes +
        Math.max(interval.duration, MIN_EVENT_HEIGHT_MINUTES),
    }))
    .sort((a, b) => {
      if (a.startMinutes !== b.startMinutes) {
        return a.startMinutes - b.startMinutes;
      }
      if (a.endMinutes !== b.endMinutes) return b.endMinutes - a.endMinutes;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const result = new Map<string, CalendarEventLayout>();
  let group: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;

  const finishGroup = () => {
    const laneCount = laneEnds.length;
    for (const event of group) {
      result.set(event.id, { lane: event.lane, laneCount });
    }
    group = [];
    laneEnds = [];
  };

  for (const interval of sorted) {
    if (group.length > 0 && interval.startMinutes >= groupEnd) {
      finishGroup();
      groupEnd = -Infinity;
    }

    let lane = laneEnds.findIndex(
      (laneEnd) => laneEnd <= interval.startMinutes,
    );
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = interval.endMinutes;
    group.push({ id: interval.id, lane });
    groupEnd = Math.max(groupEnd, interval.endMinutes);
  }

  if (group.length > 0) finishGroup();
  return result;
}

export function getEventLaneInsets(
  layout: CalendarEventLayout | undefined,
  compact: boolean,
): { insetInlineStart: string; insetInlineEnd: string } {
  const { lane, laneCount } = layout ?? { lane: 0, laneCount: 1 };
  const startFraction = lane / laneCount;
  const endFraction = (lane + 1) / laneCount;
  const remainingFraction = 1 - endFraction;
  const baseStart = compact ? 0 : 68;
  const baseEnd = compact ? 0 : 8;
  const startGap = lane > 0 ? 2 : 0;
  const endGap = lane < laneCount - 1 ? 2 : 0;
  const startOffset =
    baseStart * (1 - startFraction) - baseEnd * startFraction + startGap;
  const endOffset =
    -baseStart * remainingFraction +
    baseEnd * (1 - remainingFraction) +
    endGap;

  return {
    insetInlineStart: `calc(${startFraction * 100}% + ${startOffset}px)`,
    insetInlineEnd: `calc(${remainingFraction * 100}% + ${endOffset}px)`,
  };
}

export function shortDayName(date: Date): string {
  return formatDatePreferred(date, { weekday: "short" });
}

export function formatMonthLong(date: Date): string {
  return formatDatePreferred(date, { month: "long" });
}
