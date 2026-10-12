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
export const MINUTES_PER_DAY = TOTAL_HOURS * 60;
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

/**
 * Format a time-of-day range. Either end may fall outside the day (negative,
 * or past midnight) when an event crosses midnight; both are shown as plain
 * times then, since `formatRange` would spell out the two dates.
 */
export function formatTimeRange(startMinutes: number, endMinutes: number): string {
  const toDate = (minutes: number) => {
    const m = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const date = new Date();
    date.setHours(Math.floor(m / 60), m % 60, 0, 0);
    return date;
  };
  const formatter = createDateTimeFormatter({
    hour: "numeric",
    minute: "2-digit",
  });
  const start = toDate(startMinutes);
  const end = toDate(endMinutes);
  if (startMinutes >= 0 && endMinutes <= MINUTES_PER_DAY) {
    return formatter.formatRange(start, end);
  }
  return `${formatter.format(start)} – ${formatter.format(end)}`;
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

// ── Events across midnight ──
//
// An event that runs past midnight is drawn as one piece per day it covers.
// Every grid computation works in minutes from the start of the day being
// drawn, so the piece on the second day starts at a negative minute.

/** Whole days from `b` to `a`, by calendar date (23- and 25-hour days count as one). */
function daysBetween(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ua - ub) / 86_400_000);
}

/**
 * Where an event starts, in minutes from the start of `day`. Negative when it
 * started on an earlier day.
 */
export function pageStartMinOnDay(page: ICalendarPage, day: Date): number {
  const start = zonedWallDate(page.scheduledAt);
  return (
    daysBetween(start, day) * MINUTES_PER_DAY +
    start.getHours() * 60 +
    start.getMinutes()
  );
}

/**
 * The part of an event that falls on one day, given its start in minutes from
 * that day's start. Null when the event doesn't touch the day.
 */
export function clipToDay(
  startMinutes: number,
  duration: number,
): { startMinutes: number; endMinutes: number } | null {
  const start = Math.max(0, startMinutes);
  const end = Math.min(MINUTES_PER_DAY, startMinutes + duration);
  return end > start ? { startMinutes: start, endMinutes: end } : null;
}

/**
 * Keys (see `dayKey`) of every day an event covers. An event that ends exactly
 * at midnight doesn't reach into the next day.
 */
export function eventDayKeys(scheduledAt: string, duration: number): string[] {
  const start = zonedWallDate(scheduledAt);
  const startMin = start.getHours() * 60 + start.getMinutes();
  const dayCount = Math.max(1, Math.ceil((startMin + duration) / MINUTES_PER_DAY));
  return Array.from({ length: dayCount }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return dayKey(d);
  });
}

/**
 * Where a dragged event may start, in minutes from the start of the day it is
 * dropped on. An event that starts on this day stays on it, as before. The
 * piece of an event that started the day before may keep starting there, as
 * long as one snap step of it stays on this day.
 */
export function clampDragStartMin(
  oldStartMin: number,
  newStartMin: number,
  duration: number,
): number {
  const min = oldStartMin < 0 ? SNAP_MINUTES - duration : 0;
  return Math.max(min, Math.min(newStartMin, MINUTES_PER_DAY - SNAP_MINUTES));
}

/**
 * The longest a grid resize can make an event: to the end of the day its
 * bottom edge is dragged on, and never past a day, which is also the longest
 * duration the event drawer offers.
 */
export function maxResizeMinutes(startMinutesOnDay: number): number {
  return Math.min(MINUTES_PER_DAY - startMinutesOnDay, MINUTES_PER_DAY);
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// ── All-day events ──
//
// An all-day event is stored as the start of its first day in the display
// zone, with a duration of whole days. Its days are read the same way the
// reminders read them: the stored instant seen in the display zone.

/** The stored start of an all-day event on `day`. */
export function allDayStartIso(day: Date): string {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  return wallDateToUtcIso(start);
}

/**
 * How many days an all-day event covers. Rounded rather than counted from its
 * start minute, so one stored in another zone (and so not starting at this
 * zone's midnight) still covers one day, not two.
 */
export function allDayDayCount(duration: number | null): number {
  return Math.max(1, Math.round((duration || MINUTES_PER_DAY) / MINUTES_PER_DAY));
}

/** One all-day event placed in the all-day row. Columns are indexes into the row's days. */
export interface AllDaySpan {
  page: ICalendarPage;
  startCol: number;
  /** Exclusive. */
  endCol: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * Place all-day events across the row's `days`: each spans the columns of the
 * days it covers, clipped to the row, and stacks in the first lane free there.
 */
export function layoutAllDayRow(
  pages: readonly ICalendarPage[],
  days: readonly Date[],
): AllDaySpan[] {
  if (days.length === 0) return [];
  const spans: Omit<AllDaySpan, "lane">[] = [];
  for (const page of pages) {
    const first = daysBetween(zonedWallDate(page.scheduledAt), days[0]);
    const last = first + allDayDayCount(page.duration);
    const startCol = Math.max(0, first);
    const endCol = Math.min(days.length, last);
    if (endCol <= startCol) continue;
    spans.push({
      page,
      startCol,
      endCol,
      continuesBefore: first < 0,
      continuesAfter: last > days.length,
    });
  }
  // Earlier first, then longer, so long spans keep the top lanes.
  spans.sort(
    (a, b) =>
      a.startCol - b.startCol ||
      b.endCol - b.startCol - (a.endCol - a.startCol) ||
      a.page.id.localeCompare(b.page.id),
  );
  const laneEnds: number[] = [];
  return spans.map((span) => {
    let lane = laneEnds.findIndex((end) => end <= span.startCol);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = span.endCol;
    return { ...span, lane };
  });
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
