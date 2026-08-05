import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOUR_HEIGHT,
  MAX_HOUR_HEIGHT,
  MIN_HOUR_HEIGHT,
  clampHourHeight,
  layoutCalendarIntervals,
  pxToMinutes,
  snapPx,
} from "./utils";

describe("layoutCalendarIntervals", () => {
  it("keeps separate events at full width", () => {
    const layouts = layoutCalendarIntervals([
      { id: "first", startMinutes: 60, duration: 30 },
      { id: "second", startMinutes: 90, duration: 30 },
    ]);

    expect(layouts.get("first")).toEqual({ lane: 0, laneCount: 1 });
    expect(layouts.get("second")).toEqual({ lane: 0, laneCount: 1 });
  });

  it("assigns simultaneous events to separate lanes", () => {
    const layouts = layoutCalendarIntervals([
      { id: "third", startMinutes: 60, duration: 30 },
      { id: "first", startMinutes: 60, duration: 30 },
      { id: "second", startMinutes: 60, duration: 30 },
    ]);

    expect(layouts.get("first")).toEqual({ lane: 0, laneCount: 3 });
    expect(layouts.get("second")).toEqual({ lane: 1, laneCount: 3 });
    expect(layouts.get("third")).toEqual({ lane: 2, laneCount: 3 });
  });

  it("reuses lanes across a connected overlap group", () => {
    const layouts = layoutCalendarIntervals([
      { id: "long", startMinutes: 60, duration: 90 },
      { id: "early", startMinutes: 60, duration: 30 },
      { id: "late", startMinutes: 90, duration: 30 },
    ]);

    expect(layouts.get("long")).toEqual({ lane: 0, laneCount: 2 });
    expect(layouts.get("early")).toEqual({ lane: 1, laneCount: 2 });
    expect(layouts.get("late")).toEqual({ lane: 1, laneCount: 2 });
  });

  it("keeps back-to-back short events at full width", () => {
    const layouts = layoutCalendarIntervals([
      { id: "short", startMinutes: 60, duration: 15 },
      { id: "next", startMinutes: 75, duration: 15 },
    ]);

    expect(layouts.get("short")).toEqual({ lane: 0, laneCount: 1 });
    expect(layouts.get("next")).toEqual({ lane: 0, laneCount: 1 });
  });

  it("separates events that share a start but have no duration", () => {
    const layouts = layoutCalendarIntervals([
      { id: "first", startMinutes: 60, duration: 0 },
      { id: "second", startMinutes: 60, duration: 0 },
    ]);

    expect(layouts.get("first")?.laneCount).toBe(2);
    expect(layouts.get("second")?.laneCount).toBe(2);
  });
});

describe("zoomable hour scale", () => {
  it("reads px as time against the current hour height", () => {
    expect(pxToMinutes(DEFAULT_HOUR_HEIGHT, DEFAULT_HOUR_HEIGHT)).toBe(60);
    expect(pxToMinutes(30, 120)).toBe(15);
    expect(pxToMinutes(30, 30)).toBe(60);
  });

  it("snaps px to the 15-minute step at every zoom level", () => {
    expect(snapPx(20, 120)).toBe(30); // 15-min step = 30px
    expect(snapPx(45, MIN_HOUR_HEIGHT)).toBe(45); // 15-min step = 5px, stays fine
  });

  it("keeps the hour height inside the zoom range", () => {
    expect(clampHourHeight(5)).toBe(MIN_HOUR_HEIGHT);
    expect(clampHourHeight(9999)).toBe(MAX_HOUR_HEIGHT);
    expect(clampHourHeight(Number.NaN)).toBe(DEFAULT_HOUR_HEIGHT);
  });
});
