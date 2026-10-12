import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOUR_HEIGHT,
  allDayDayCount,
  MAX_HOUR_HEIGHT,
  MIN_HOUR_HEIGHT,
  clampDragStartMin,
  clampHourHeight,
  clipToDay,
  dayKey,
  eventDayKeys,
  layoutAllDayRow,
  layoutCalendarIntervals,
  maxResizeMinutes,
  pageStartMinOnDay,
  pxToMinutes,
  snapPx,
} from "./utils";
import type { ICalendarPage } from "../../api/pages.api";

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

describe("events across midnight", () => {
  const at = (y: number, m: number, d: number, h: number, min = 0) =>
    new Date(y, m, d, h, min).toISOString();
  const page = (scheduledAt: string, duration: number) =>
    ({ scheduledAt, duration }) as ICalendarPage;

  it("measures the start from the day being drawn", () => {
    const late = page(at(2026, 9, 12, 23), 120);
    expect(pageStartMinOnDay(late, new Date(2026, 9, 12))).toBe(23 * 60);
    expect(pageStartMinOnDay(late, new Date(2026, 9, 13))).toBe(-60);
  });

  it("lists every day an event covers", () => {
    expect(eventDayKeys(at(2026, 9, 12, 23), 120)).toEqual([
      dayKey(new Date(2026, 9, 12)),
      dayKey(new Date(2026, 9, 13)),
    ]);
    expect(eventDayKeys(at(2026, 9, 31, 23), 120)).toEqual([
      dayKey(new Date(2026, 9, 31)),
      dayKey(new Date(2026, 10, 1)),
    ]);
  });

  it("does not reach into the next day when it ends at midnight", () => {
    expect(eventDayKeys(at(2026, 9, 12, 23), 60)).toEqual([
      dayKey(new Date(2026, 9, 12)),
    ]);
  });

  it("clips an event to the part on one day", () => {
    expect(clipToDay(23 * 60, 120)).toEqual({
      startMinutes: 23 * 60,
      endMinutes: 24 * 60,
    });
    expect(clipToDay(-60, 120)).toEqual({ startMinutes: 0, endMinutes: 60 });
    expect(clipToDay(-60, 60)).toBeNull();
    expect(clipToDay(24 * 60, 30)).toBeNull();
  });

  it("keeps a dragged event on its own day", () => {
    expect(clampDragStartMin(60, -120, 60)).toBe(0);
    expect(clampDragStartMin(60, 24 * 60, 60)).toBe(24 * 60 - 15);
  });

  it("lets the piece after midnight keep starting the day before", () => {
    expect(clampDragStartMin(-60, -90, 120)).toBe(-90);
    expect(clampDragStartMin(-60, -200, 120)).toBe(15 - 120);
  });

  it("resizes up to the end of the day the edge is on", () => {
    expect(maxResizeMinutes(23 * 60)).toBe(60);
    expect(maxResizeMinutes(-60)).toBe(24 * 60);
  });
});

describe("all-day row", () => {
  const page = (id: string, y: number, m: number, d: number, days = 1, h = 0) =>
    ({
      id,
      scheduledAt: new Date(y, m, d, h).toISOString(),
      duration: days * 24 * 60,
    }) as ICalendarPage;
  const week = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 11 + i));

  it("puts each event under its own day", () => {
    const spans = layoutAllDayRow(
      [page("a", 2026, 9, 13), page("b", 2026, 9, 16)],
      week,
    );
    expect(spans.map((s) => [s.page.id, s.startCol, s.endCol, s.lane])).toEqual([
      ["a", 2, 3, 0],
      ["b", 5, 6, 0],
    ]);
  });

  it("leaves out events on other days", () => {
    expect(layoutAllDayRow([page("a", 2026, 9, 13)], [week[0]])).toEqual([]);
  });

  it("clips a multi-day event to the row and marks the cut ends", () => {
    const [span] = layoutAllDayRow([page("a", 2026, 9, 9, 4)], week);
    expect(span).toMatchObject({
      startCol: 0,
      endCol: 2,
      continuesBefore: true,
      continuesAfter: false,
    });
  });

  it("stacks overlapping events and reuses free lanes", () => {
    const spans = layoutAllDayRow(
      [page("short", 2026, 9, 12), page("long", 2026, 9, 11, 3), page("later", 2026, 9, 15)],
      week,
    );
    expect(Object.fromEntries(spans.map((s) => [s.page.id, s.lane]))).toEqual({
      long: 0,
      short: 1,
      later: 0,
    });
  });

  it("counts whole days even when the start is off midnight", () => {
    expect(allDayDayCount(24 * 60)).toBe(1);
    expect(allDayDayCount(null)).toBe(1);
    expect(allDayDayCount(3 * 24 * 60)).toBe(3);
    const [span] = layoutAllDayRow([page("a", 2026, 9, 13, 1, 2)], week);
    expect(span.endCol - span.startCol).toBe(1);
  });
});
