import { describe, expect, it } from "vitest";
import { layoutCalendarIntervals } from "./utils";

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

  it("accounts for the minimum rendered card height", () => {
    const layouts = layoutCalendarIntervals([
      { id: "short", startMinutes: 60, duration: 15 },
      { id: "next", startMinutes: 75, duration: 15 },
    ]);

    expect(layouts.get("short")?.laneCount).toBe(2);
    expect(layouts.get("next")?.laneCount).toBe(2);
  });
});
