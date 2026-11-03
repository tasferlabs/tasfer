import { describe, expect, it } from "vitest";
import {
  endRuleBefore,
  exceptionPageId,
  expandOccurrences,
  formatRecurrence,
  occurrencesBefore,
  parseRecurrence,
  shiftOccurrenceKey,
  shiftRule,
} from "./recurrence";

const rule = (raw: string) => {
  const r = parseRecurrence(raw);
  if (!r) throw new Error(`unparsable: ${raw}`);
  return r;
};

describe("parseRecurrence / formatRecurrence", () => {
  it("round-trips the parts it knows and keeps the ones it does not", () => {
    const raw =
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T225959Z;BYSETPOS=1;TZID=Europe/Berlin";
    const r = rule(raw);
    expect(r.freq).toBe("WEEKLY");
    expect(r.interval).toBe(2);
    expect(r.byDay.map((d) => d.day)).toEqual(["MO", "WE"]);
    expect(r.until).toBe("2026-12-31T22:59:59Z");
    expect(r.extra).toEqual(["BYSETPOS=1"]);
    expect(rule(formatRecurrence(r))).toEqual(r);
  });

  it("rejects what it cannot expand", () => {
    expect(parseRecurrence("")).toBeNull();
    expect(parseRecurrence("INTERVAL=2")).toBeNull();
    expect(parseRecurrence("FREQ=HOURLY")).toBeNull();
  });

  it("reads ordinal weekdays", () => {
    expect(rule("FREQ=MONTHLY;BYDAY=-1FR").byDay).toEqual([
      { n: -1, day: "FR" },
    ]);
  });
});

describe("expandOccurrences", () => {
  it("keeps the wall-clock time across a daylight-saving change", () => {
    // Berlin leaves summer time on 2026-10-25.
    const out = expandOccurrences(
      "2026-10-19T07:00:00.000Z", // Monday 09:00 CEST
      rule("FREQ=WEEKLY;TZID=Europe/Berlin"),
      "2026-10-01T00:00:00Z",
      "2026-11-05T00:00:00Z",
    );
    expect(out).toEqual([
      "2026-10-19T07:00:00.000Z",
      "2026-10-26T08:00:00.000Z", // 09:00 CET
      "2026-11-02T08:00:00.000Z",
    ]);
  });

  it("expands weekly rules on several weekdays with an interval", () => {
    const out = expandOccurrences(
      "2026-10-12T09:00:00.000Z", // Monday
      rule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;TZID=UTC"),
      "2026-10-01T00:00:00Z",
      "2026-11-01T00:00:00Z",
    );
    expect(out).toEqual([
      "2026-10-12T09:00:00.000Z",
      "2026-10-15T09:00:00.000Z",
      "2026-10-26T09:00:00.000Z",
      "2026-10-29T09:00:00.000Z",
    ]);
  });

  it("never yields anything before DTSTART", () => {
    const out = expandOccurrences(
      "2026-10-14T09:00:00.000Z", // Wednesday
      rule("FREQ=WEEKLY;BYDAY=MO,WE,FR;TZID=UTC"),
      "2026-10-01T00:00:00Z",
      "2026-10-17T00:00:00Z",
    );
    expect(out).toEqual([
      "2026-10-14T09:00:00.000Z",
      "2026-10-16T09:00:00.000Z",
    ]);
  });

  it("counts COUNT from DTSTART even when the range starts later", () => {
    const out = expandOccurrences(
      "2026-01-01T09:00:00.000Z",
      rule("FREQ=DAILY;COUNT=5;TZID=UTC"),
      "2026-01-04T00:00:00Z",
      "2026-02-01T00:00:00Z",
    );
    expect(out).toEqual([
      "2026-01-04T09:00:00.000Z",
      "2026-01-05T09:00:00.000Z",
    ]);
  });

  it("stops at UNTIL", () => {
    const out = expandOccurrences(
      "2026-01-01T09:00:00.000Z",
      rule("FREQ=DAILY;UNTIL=20260103T090000Z;TZID=UTC"),
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
    );
    expect(out).toHaveLength(3);
  });

  it("skips months without the day, as RFC 5545 does", () => {
    const out = expandOccurrences(
      "2026-01-31T09:00:00.000Z",
      rule("FREQ=MONTHLY;TZID=UTC"),
      "2026-01-01T00:00:00Z",
      "2026-06-01T00:00:00Z",
    );
    expect(out).toEqual([
      "2026-01-31T09:00:00.000Z",
      "2026-03-31T09:00:00.000Z",
      "2026-05-31T09:00:00.000Z",
    ]);
  });

  it("finds the nth and last weekday of a month", () => {
    const second = expandOccurrences(
      "2026-10-13T09:00:00.000Z",
      rule("FREQ=MONTHLY;BYDAY=2TU;TZID=UTC"),
      "2026-10-01T00:00:00Z",
      "2026-12-31T00:00:00Z",
    );
    expect(second).toEqual([
      "2026-10-13T09:00:00.000Z",
      "2026-11-10T09:00:00.000Z",
      "2026-12-08T09:00:00.000Z",
    ]);
    const last = expandOccurrences(
      "2026-10-30T09:00:00.000Z",
      rule("FREQ=MONTHLY;BYDAY=-1FR;TZID=UTC"),
      "2026-10-01T00:00:00Z",
      "2026-12-31T00:00:00Z",
    );
    expect(last).toEqual([
      "2026-10-30T09:00:00.000Z",
      "2026-11-27T09:00:00.000Z",
      "2026-12-25T09:00:00.000Z",
    ]);
  });

  it("puts Feb 29 only in leap years", () => {
    const out = expandOccurrences(
      "2024-02-29T09:00:00.000Z",
      rule("FREQ=YEARLY;TZID=UTC"),
      "2024-01-01T00:00:00Z",
      "2029-01-01T00:00:00Z",
    );
    expect(out).toEqual([
      "2024-02-29T09:00:00.000Z",
      "2028-02-29T09:00:00.000Z",
    ]);
  });

  it("jumps straight to a far-off range for a series that never ends", () => {
    const out = expandOccurrences(
      "2000-01-03T09:00:00.000Z",
      rule("FREQ=DAILY;TZID=UTC"),
      "2026-10-12T00:00:00Z",
      "2026-10-13T23:59:59Z",
    );
    expect(out).toEqual([
      "2026-10-12T09:00:00.000Z",
      "2026-10-13T09:00:00.000Z",
    ]);
  });
});

describe("splitting a series", () => {
  it("ends the old rule just before the split and counts what came before", () => {
    const r = rule("FREQ=DAILY;COUNT=10;TZID=UTC");
    const dtstart = "2026-01-01T09:00:00.000Z";
    const split = "2026-01-04T09:00:00.000Z";
    expect(occurrencesBefore(dtstart, r, split)).toBe(3);
    const ended = endRuleBefore(r, split);
    expect(ended.count).toBeNull();
    expect(
      expandOccurrences(dtstart, ended, dtstart, "2026-02-01T00:00:00Z"),
    ).toHaveLength(3);
  });
});

describe("exceptionPageId", () => {
  it("is the same for any spelling of the same instant", () => {
    expect(exceptionPageId("abc", "2026-10-12T09:00:00.000Z")).toBe(
      exceptionPageId("abc", "2026-10-12T11:00:00+02:00"),
    );
  });
});

describe("moving a whole series", () => {
  it("shifts weekly days and occurrence keys by the same days", () => {
    const r = rule("FREQ=WEEKLY;BYDAY=MO,WE;TZID=UTC");
    const oldStart = "2026-10-12T09:00:00.000Z"; // Monday
    const newStart = "2026-10-13T10:00:00.000Z"; // Tuesday, an hour later
    expect(shiftRule(r, oldStart, newStart).byDay.map((d) => d.day)).toEqual([
      "TU",
      "TH",
    ]);
    expect(
      shiftOccurrenceKey("2026-10-14T09:00:00.000Z", oldStart, newStart, "UTC"),
    ).toBe("2026-10-15T10:00:00.000Z");
  });

  it("re-reads a monthly nth weekday from the new start", () => {
    const r = rule("FREQ=MONTHLY;BYDAY=2TU;TZID=UTC");
    const moved = shiftRule(
      r,
      "2026-10-13T09:00:00.000Z",
      "2026-10-22T09:00:00.000Z",
    );
    expect(moved.byDay).toEqual([{ n: 4, day: "TH" }]);
  });
});
