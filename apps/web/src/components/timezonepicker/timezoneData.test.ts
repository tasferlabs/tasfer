import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  buildZoneEntries,
  cityLabel,
  filterZones,
  formatGmtOffset,
  parseOffsetQuery,
  timeOfDayColor,
  withZone,
  zoneOffsetMinutes,
} from "./timezoneData";

describe("cityLabel", () => {
  it("uses the last identifier segment with spaces", () => {
    expect(cityLabel("Europe/Stockholm")).toBe("Stockholm");
    expect(cityLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(cityLabel("UTC")).toBe("UTC");
  });
});

describe("parseOffsetQuery", () => {
  it("parses bare, gmt- and utc-prefixed offsets", () => {
    expect(parseOffsetQuery("+2")).toBe(120);
    expect(parseOffsetQuery("-5")).toBe(-300);
    expect(parseOffsetQuery("gmt+2")).toBe(120);
    expect(parseOffsetQuery("GMT -5")).toBe(-300);
    expect(parseOffsetQuery("utc+5:30")).toBe(330);
    expect(parseOffsetQuery("utc+0530")).toBe(330);
    expect(parseOffsetQuery("utc")).toBe(0);
  });

  it("rejects non-offset queries and out-of-range offsets", () => {
    expect(parseOffsetQuery("stockholm")).toBeNull();
    expect(parseOffsetQuery("+15")).toBeNull();
    expect(parseOffsetQuery("gmt+2:75")).toBeNull();
    expect(parseOffsetQuery("")).toBeNull();
  });
});

describe("formatGmtOffset", () => {
  it("formats whole and fractional offsets", () => {
    expect(formatGmtOffset(0)).toBe("GMT+0");
    expect(formatGmtOffset(120)).toBe("GMT+2");
    expect(formatGmtOffset(-300)).toBe("GMT-5");
    expect(formatGmtOffset(330)).toBe("GMT+5:30");
    expect(formatGmtOffset(-210)).toBe("GMT-3:30");
  });
});

describe("zone entries and filtering", () => {
  const now = DateTime.fromISO("2026-07-12T12:00:00Z", { setZone: true });
  const entries = buildZoneEntries("en");
  const offsets = new Map(
    entries.map((entry) => [entry.id, zoneOffsetMinutes(entry.id, now)]),
  );

  it("builds a list including canonical city zones", () => {
    const ids = entries.map((entry) => entry.id);
    expect(ids).toContain("Europe/Stockholm");
    expect(ids).toContain("Asia/Tokyo");
    expect(ids.some((id) => id.startsWith("Etc/"))).toBe(false);
  });

  it("matches by city regardless of case and diacritics", () => {
    const results = filterZones(entries, "STOCKholm", offsets);
    expect(results.map((entry) => entry.id)).toContain("Europe/Stockholm");
  });

  it("matches by localized zone name", () => {
    const results = filterZones(entries, "japan standard", offsets);
    expect(results.map((entry) => entry.id)).toContain("Asia/Tokyo");
  });

  it("matches by offset query using the current offset", () => {
    const results = filterZones(entries, "gmt+9", offsets);
    const ids = results.map((entry) => entry.id);
    expect(ids).toContain("Asia/Tokyo");
    expect(ids).not.toContain("Europe/Stockholm");
  });

  it("requires all tokens to match", () => {
    const results = filterZones(entries, "new york", offsets);
    expect(results.map((entry) => entry.id)).toEqual(["America/New_York"]);
  });

  it("keeps an unknown selected zone selectable", () => {
    const extended = withZone(entries, "Mars/Olympus_Mons");
    expect(extended[0]).toMatchObject({
      id: "Mars/Olympus_Mons",
      city: "Olympus Mons",
    });
    expect(withZone(entries, "Europe/Stockholm")).toBe(entries);
  });
});

describe("time-of-day rendering helpers", () => {
  it("maps hours onto the theme anchor variables", () => {
    expect(timeOfDayColor(2)).toBe("var(--timeofday-night)");
    expect(timeOfDayColor(13)).toBe("var(--timeofday-day)");
    const dawnTransition = timeOfDayColor(6);
    expect(dawnTransition).toContain("color-mix");
    expect(dawnTransition).toContain("--timeofday-night");
    expect(dawnTransition).toContain("--timeofday-dawn");
    expect(timeOfDayColor(25)).toBe(timeOfDayColor(1));
    expect(timeOfDayColor(-1)).toBe(timeOfDayColor(23));
  });
});
