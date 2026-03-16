import type { ICalendarPage } from "../../api/pages.api";
import {
  formatTimePreferred,
  formatDatePreferred,
  createDateTimeFormatter,
  getWeekStart,
} from "@/lib/dateTimePreferences";

// ── Constants ──

export const HOUR_HEIGHT = 60;
export const TOTAL_HOURS = 24;
export const SNAP_MINUTES = 15;
export const MIN_DRAG_MINUTES = 15;
export const SNAP_PX = (SNAP_MINUTES / 60) * HOUR_HEIGHT;

export type ViewMode = "day" | "week";

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
  const date = new Date(timestamp);
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
  const d = new Date(page.scheduledAt);
  return d.getHours() * 60 + d.getMinutes();
}

export function shortDayName(date: Date): string {
  return formatDatePreferred(date, { weekday: "short" });
}

export function formatMonthLong(date: Date): string {
  return formatDatePreferred(date, { month: "long" });
}
