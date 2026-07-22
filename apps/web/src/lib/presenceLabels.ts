/**
 * Presence label helpers — shared by every surface that shows who's connected
 * (the active-users avatar bar and remote cursor name tags).
 *
 * The device form factor is only ever surfaced to disambiguate: when two
 * connected people share a display name, the device hint is what tells them
 * apart. These helpers keep that rule in one place so the avatar bar and the
 * canvas cursor labels stay consistent.
 */

import type { LabelIconShape } from "@tasfer/editor";

/**
 * Given the resolved display names of all visible peers, return the set of names
 * (lowercased) that more than one peer shares. Matching is case-insensitive, so
 * "Alice" and "alice" collide.
 */
export function collidingDisplayNames(names: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const name of names) {
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const colliding = new Set<string>();
  for (const [key, count] of counts) {
    if (count > 1) colliding.add(key);
  }
  return colliding;
}

/** Whether a name collides within `colliding` (from {@link collidingDisplayNames}). */
export function isCollidingName(name: string, colliding: Set<string>): boolean {
  return colliding.has(name.toLowerCase());
}

/**
 * Device glyphs as 24×24-viewBox primitives, mirroring the lucide icons the
 * avatar bar renders (laptop / monitor / smartphone / tablet, lucide-react
 * v0.532.0). The canvas can't mount a React icon, so the geometry is passed
 * through as decoration primitives instead — same shapes, same look. If lucide
 * is upgraded and these drift, re-copy the `__iconNode` data for these icons.
 */
const DEVICE_ICONS: Record<string, readonly LabelIconShape[]> = {
  laptop: [
    {
      shape: "path",
      d: "M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z",
    },
    { shape: "path", d: "M20.054 15.987H3.946" },
  ],
  desktop: [
    { shape: "rect", x: 2, y: 3, width: 20, height: 14, rx: 2 },
    { shape: "line", x1: 8, y1: 21, x2: 16, y2: 21 },
    { shape: "line", x1: 12, y1: 17, x2: 12, y2: 21 },
  ],
  phone: [
    { shape: "rect", x: 5, y: 2, width: 14, height: 20, rx: 2 },
    { shape: "path", d: "M12 18h.01" },
  ],
  tablet: [
    { shape: "rect", x: 4, y: 2, width: 16, height: 20, rx: 2 },
    { shape: "line", x1: 12, y1: 18, x2: 12.01, y2: 18 },
  ],
};

/** The device glyph for a form factor, or undefined when it's unknown. */
export function deviceIcon(
  deviceType: string | undefined,
): readonly LabelIconShape[] | undefined {
  return deviceType ? DEVICE_ICONS[deviceType] : undefined;
}
