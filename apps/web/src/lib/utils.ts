import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { TFunction } from "i18next"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export type { TFunction };

export function formatDurationLabel(minutes: number, t: TFunction): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return t("format.minutes", { defaultValue: "{{count}} min", count: mins });
  if (mins === 0) return t("format.hours", { defaultValue: "{{count}} hr", count: hours });
  return t("format.hoursMinutes", { defaultValue: "{{hours}} hr {{mins}} min", hours, mins });
}

// 15 min up to a full day, in quarter-hour steps.
export const DURATION_OPTIONS = Array.from(
  { length: (24 * 60) / 15 },
  (_, i) => (i + 1) * 15,
);

export function shallowEqual(objA: any, objB: any) {
  if (objA === objB) {
    return true;
  }

  if (
    typeof objA !== "object" ||
    objA === null ||
    typeof objB !== "object" ||
    objB === null
  ) {
    return false;
  }

  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (objA[key] !== objB[key]) {
      return false;
    }
  }

  return true;
}
