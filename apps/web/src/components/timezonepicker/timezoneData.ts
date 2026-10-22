import { DateTime } from "luxon";
import type { FrecencyEntry } from "@/lib/actionRanking";
import {
  readTally,
  trimTally,
  updateOwnTally,
  type Tally,
  type TallyPrefs,
} from "@/lib/deviceTally";

/** One selectable IANA time zone, prepared for display and search. */
export interface ZoneEntry {
  /** IANA identifier, e.g. "Europe/Stockholm". */
  id: string;
  /** Human city label derived from the identifier, e.g. "Buenos Aires". */
  city: string;
  /** Normalized search haystack: city, identifier, localized zone names. */
  haystack: string;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[_\-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cityLabel(zoneId: string): string {
  const segment = zoneId.split("/").pop() ?? zoneId;
  return segment.replace(/_/g, " ");
}

function supportedZoneIds(): string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  const ids = supported.filter(
    (id) => id === "UTC" || (id.includes("/") && !id.startsWith("Etc/")),
  );
  // Environments without supportedValuesOf still get a usable minimal list.
  return ids.length > 0 ? ids : ["UTC"];
}

/**
 * Builds the zone list with localized names folded into the search haystack,
 * so "eastern time" or its translation match the matching cities. Creating
 * the per-zone formatters is the expensive part (~one-time cost, cached by
 * luxon afterwards); callers should build lazily and memoize per locale.
 */
export function buildZoneEntries(locale: string): ZoneEntry[] {
  const now = DateTime.now();
  return supportedZoneIds().map((id) => {
    const zoned = now.setZone(id, { keepLocalTime: false }).setLocale(locale);
    const names = zoned.isValid
      ? `${zoned.offsetNameLong ?? ""} ${zoned.offsetNameShort ?? ""}`
      : "";
    const city = cityLabel(id);
    return {
      id,
      city,
      haystack: normalize(`${city} ${id} ${names}`),
    };
  });
}

/** One region group of the zone list: a heading and the zones under it. */
export interface ZoneGroup {
  /** IANA area prefix, e.g. "Europe"; the group's stable key. */
  region: string;
  /** Localized heading text. */
  label: string;
  entries: ZoneEntry[];
}

/** IANA area prefix of a zone id; ids without one (UTC) group under "UTC". */
export function zoneRegion(zoneId: string): string {
  const [head, rest] = zoneId.split("/");
  return rest === undefined ? "UTC" : head;
}

// The regions Intl.supportedValuesOf can return, mapped to their i18n key
// suffix. A zone injected by `withZone` can carry a legacy prefix ("US/
// Eastern") that is not in here; those fall back to the raw prefix.
const REGION_LABEL_KEYS: Record<string, string> = {
  Africa: "africa",
  America: "americas",
  Antarctica: "antarctica",
  Arctic: "arctic",
  Asia: "asia",
  Atlantic: "atlantic",
  Australia: "australia",
  Europe: "europe",
  Indian: "indian",
  Pacific: "pacific",
  UTC: "utc",
};

/** Translation key for a region heading, or null when it has no fixed label. */
export function regionLabelKey(region: string): string | null {
  const suffix = REGION_LABEL_KEYS[region];
  return suffix ? `timezone.region.${suffix}` : null;
}

/**
 * Groups zones by IANA area for a list that is scrolled by thumb rather than
 * scanned with a scrollbar: offset order scatters a continent across the whole
 * list, while a region heading is a landmark you can aim at. Groups and the
 * cities inside them are ordered by the display locale's collation, so the
 * headings read alphabetically in the language they are shown in.
 */
export function groupZonesByRegion(
  entries: ZoneEntry[],
  label: (region: string) => string,
  locale: string,
): ZoneGroup[] {
  const byRegion = new Map<string, ZoneEntry[]>();
  for (const entry of entries) {
    const region = zoneRegion(entry.id);
    const list = byRegion.get(region);
    if (list) list.push(entry);
    else byRegion.set(region, [entry]);
  }
  const collator = new Intl.Collator(locale);
  return [...byRegion.entries()]
    .map(([region, list]) => ({
      region,
      label: label(region),
      entries: [...list].sort((a, b) => collator.compare(a.city, b.city)),
    }))
    .sort((a, b) => collator.compare(a.label, b.label));
}

/** Ensures the current value is selectable even if it is not in the list. */
export function withZone(entries: ZoneEntry[], zoneId: string): ZoneEntry[] {
  if (entries.some((entry) => entry.id === zoneId)) return entries;
  const city = cityLabel(zoneId);
  return [{ id: zoneId, city, haystack: normalize(`${city} ${zoneId}`) }, ...entries];
}

/** Current UTC offset in minutes for a zone; 0 when the zone is unknown. */
export function zoneOffsetMinutes(zoneId: string, now: DateTime): number {
  const zoned = now.setZone(zoneId);
  return zoned.isValid ? zoned.offset : 0;
}

/** Formats an offset in minutes as "GMT+2" or "GMT-3:30". */
export function formatGmtOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `GMT${sign}${hours}${minutes > 0 ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

/**
 * Parses an offset-style query like "+2", "gmt-5", "utc+5:30" into minutes.
 * Returns null when the query is not an offset search.
 */
export function parseOffsetQuery(query: string): number | null {
  const compact = query.replace(/\s+/g, "").toLowerCase();
  if (compact === "utc" || compact === "gmt") return 0;
  const match = compact.match(/^(?:utc|gmt)?([+-])(\d{1,2})(?::?([0-5]\d))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  if (hours > 14) return null;
  return sign * (hours * 60 + minutes);
}

export function filterZones(
  entries: ZoneEntry[],
  query: string,
  offsets: ReadonlyMap<string, number>,
): ZoneEntry[] {
  const trimmed = query.trim();
  if (!trimmed) return entries;
  const offsetQuery = parseOffsetQuery(trimmed);
  if (offsetQuery !== null) {
    return entries.filter((entry) => offsets.get(entry.id) === offsetQuery);
  }
  const tokens = normalize(trimmed).split(" ").filter(Boolean);
  return entries.filter((entry) =>
    tokens.every((token) => entry.haystack.includes(token)),
  );
}

/**
 * Time-of-day color scale shared by the row indicators and the day strip.
 * The anchor colors live in styles.css as --timeofday-* variables with
 * separate light and dark values; this function only interpolates between
 * them with color-mix, so the scale re-tunes itself when the theme changes.
 */
const TIME_OF_DAY_ANCHORS: Array<[hour: number, anchor: string]> = [
  [0, "night"],
  [5, "night"],
  [7, "dawn"],
  [10, "day"],
  [15, "day"],
  [18.5, "dusk"],
  [21.5, "night"],
  [24, "night"],
];

export function timeOfDayColor(hourOfDay: number): string {
  const hour = ((hourOfDay % 24) + 24) % 24;
  for (let i = 0; i < TIME_OF_DAY_ANCHORS.length - 1; i++) {
    const [h0, from] = TIME_OF_DAY_ANCHORS[i];
    const [h1, to] = TIME_OF_DAY_ANCHORS[i + 1];
    if (hour >= h0 && hour <= h1) {
      if (from === to) return `var(--timeofday-${from})`;
      const t = Math.round(((hour - h0) / (h1 - h0)) * 100);
      if (t <= 0) return `var(--timeofday-${from})`;
      if (t >= 100) return `var(--timeofday-${to})`;
      return `color-mix(in oklch, var(--timeofday-${from}) ${100 - t}%, var(--timeofday-${to}))`;
    }
  }
  return "var(--timeofday-night)";
}

/**
 * Key PREFIX: `timezone.recents.<deviceKey>` → the zones that device picked,
 * with when. In the own-prefs register so a zone picked on the laptop is a
 * recent on the phone too; one key per device so two devices picking at once
 * both keep theirs (see `@/lib/deviceTally`). Mirrored in `OWN_PREF_KEYS`.
 */
export const RECENT_ZONES_PREF_PREFIX = "timezone.recents.";

/** Where this device kept its recents before they moved to the register. */
export const LEGACY_RECENT_ZONES_KEY = "tasfer.timezonePicker.recents";

const MAX_RECENT_ZONES = 3;

const latestFirst = (a: FrecencyEntry, b: FrecencyEntry) => b.last - a.last;

/** The latest few zones picked on any of the person's devices, newest first. */
export function readRecentZones(prefs: TallyPrefs): string[] {
  return Object.entries(readTally(prefs, RECENT_ZONES_PREF_PREFIX))
    .sort(([, a], [, b]) => latestFirst(a, b))
    .slice(0, MAX_RECENT_ZONES)
    .map(([zoneId]) => zoneId);
}

export function pushRecentZone(
  prefs: TallyPrefs,
  zoneId: string,
  now: number = Date.now(),
): void {
  updateOwnTally(prefs, RECENT_ZONES_PREF_PREFIX, (own) => {
    own[zoneId] = { count: (own[zoneId]?.count ?? 0) + 1, last: now };
    return trimTally(own, MAX_RECENT_ZONES, latestFirst);
  });
}

/**
 * The newest-first list this device kept in `localStorage`, adopted as its
 * own tally. It carried no times, so the order is kept with small stand-in
 * ones that any real pick outranks.
 */
export function readLegacyRecentZones(
  raw: string,
  deviceKey: string,
): Array<[string, unknown]> {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const zones = parsed.filter((z): z is string => typeof z === "string");
  if (zones.length === 0) return [];
  const tally: Tally = {};
  zones.forEach((zoneId, i) => {
    tally[zoneId] = { count: 1, last: zones.length - i };
  });
  return [[RECENT_ZONES_PREF_PREFIX + deviceKey, tally]];
}
