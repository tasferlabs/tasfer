import type { ICalendarPage } from "../../api/pages.api";

// ── Constants ──

export const HOUR_HEIGHT = 60;
export const TOTAL_HOURS = 24;
export const SNAP_MINUTES = 15;
export const MIN_DRAG_MINUTES = 15;
export const SNAP_PX = (SNAP_MINUTES / 60) * HOUR_HEIGHT;

export type ViewMode = "day" | "week";

// ── Helpers ──

export function formatHour(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function formatWeekRange(date: Date): string {
  const { start, end } = getWeekRange(date);
  const startDate = new Date(start);
  const endDate = new Date(end);
  const sameMonth = startDate.getMonth() === endDate.getMonth();
  if (sameMonth) {
    return `${startDate.toLocaleDateString(undefined, { month: "long", day: "numeric" })} - ${endDate.getDate()}, ${endDate.getFullYear()}`;
  }
  return `${startDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${endDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
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
  const day = d.getDay(); // 0=Sun
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7)); // go to Monday
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: monday.getTime(), end: sunday.getTime() };
}

export function getWeekDays(date: Date): Date[] {
  const { start } = getWeekRange(date);
  const monday = new Date(start);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0
    ? `${hour12} ${period}`
    : `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

export function formatEventTime(
  timestamp: number,
  duration?: number | null,
): string {
  const date = new Date(timestamp);
  const startMin = date.getHours() * 60 + date.getMinutes();
  if (duration) {
    return `${formatTime(startMin)} - ${formatTime(startMin + duration)}`;
  }
  return formatTime(startMin);
}

export function pxToMinutes(px: number): number {
  const raw = (px / HOUR_HEIGHT) * 60;
  return Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
}

export function snapPx(px: number): number {
  return Math.round(px / SNAP_PX) * SNAP_PX;
}

export function pageToStartMin(page: ICalendarPage): number {
  const d = new Date(page.scheduledAt);
  return d.getHours() * 60 + d.getMinutes();
}

export function shortDayName(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "short" });
}
