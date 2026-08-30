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

// The hour scale is zoomable (pinch on touch, ⌘/Ctrl + wheel on desktop), so
// every px↔time conversion takes the current hour height instead of reading a
// constant. `DEFAULT_HOUR_HEIGHT` is only the starting point.
export const DEFAULT_HOUR_HEIGHT = 60;
export const MIN_HOUR_HEIGHT = 20;
export const MAX_HOUR_HEIGHT = 180;
export const TOTAL_HOURS = 24;
// Time snaps to 15-minute lines at every zoom level. Zooming out only shrinks
// the pixels per step, never the granularity, so an event can still be placed
// or resized to the quarter-hour when the day is scaled down.
export const SNAP_MINUTES = 15;
export const MIN_DRAG_MINUTES = 15;

/**
 * Minimum duration for a newly created event, scaled to the current zoom.
 * Zoomed out, a 15-minute card shrinks to a few unreadable, un-grabbable
 * pixels, so grow the create size to keep a fresh event at least as tall as a
 * snap step looks at the default zoom. Users who want a shorter block can zoom
 * in or edit it in the drawer. At the default zoom (or closer) this is just
 * SNAP_MINUTES, so normal creation is unchanged.
 */
export function minCreateMinutes(hourHeight: number): number {
  const steps = Math.max(1, Math.ceil(DEFAULT_HOUR_HEIGHT / hourHeight));
  return steps * SNAP_MINUTES;
}

/**
 * Where a keyboard-created event starts on a day that isn't today, and how long
 * it runs. A drag says both with the pointer; pressing "c" has to pick, so it
 * picks the start of the working day and an hour — both editable before saving.
 */
export const KEYBOARD_CREATE_START_MINUTES = 9 * 60;
export const KEYBOARD_CREATE_MINUTES = 60;

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

// Cards render their real duration, so lanes are assigned from real times too
// and events that touch stay full width. The floor only keeps zero-duration
// events from stacking invisibly.
const MIN_LAYOUT_MINUTES = 1;

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

export function clampHourHeight(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_HOUR_HEIGHT;
  return Math.min(MAX_HOUR_HEIGHT, Math.max(MIN_HOUR_HEIGHT, px));
}

/**
 * Hours between rendered time labels. Zoomed out, one label per hour would
 * collide, so thin them out while keeping the hour lines.
 */
export function hourLabelStep(hourHeight: number): number {
  if (hourHeight < 26) return 3;
  if (hourHeight < 40) return 2;
  return 1;
}

export function pxToMinutes(px: number, hourHeight: number): number {
  const raw = (px / hourHeight) * 60;
  return Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
}

export function snapPx(px: number, hourHeight: number): number {
  const snap = (SNAP_MINUTES / 60) * hourHeight;
  return Math.round(px / snap) * snap;
}

// Snap an absolute start-minute to the 15-minute grid, so a dragged event lands
// on a grid line rather than preserving the original off-grid offset.
export function snapStartMin(startMin: number): number {
  return Math.round(startMin / SNAP_MINUTES) * SNAP_MINUTES;
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
        interval.startMinutes + Math.max(interval.duration, MIN_LAYOUT_MINUTES),
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
