/**
 * Vitest setup: minimal DOM stubs.
 *
 * The editor's module graph touches the DOM at import time (styles.ts reads
 * CSS custom properties via getComputedStyle, fonts measure text on a canvas
 * context, the mathjax bundle probes document.location). Tests run in a plain
 * node environment, so install just enough of a DOM for module init to
 * succeed before any test module is imported. Guarded so this stays harmless
 * if a future config switches to a real DOM environment.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;

if (typeof g.document === "undefined") {
  g.getComputedStyle = () => ({ getPropertyValue: () => "" });
  g.document = {
    documentElement: {},
    location: "http://localhost/",
    getElementsByTagName: () => [],
    createElement: () => ({
      getContext: () => ({ measureText: () => ({ width: 5 }) }),
      style: {},
      setAttribute: () => {},
      appendChild: () => {},
    }),
    createElementNS: () => ({
      style: {},
      setAttribute: () => {},
      appendChild: () => {},
    }),
    addEventListener: () => {},
  };
  g.window = {
    addEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    devicePixelRatio: 1,
    document: g.document,
  };
}

// Node ≥21 ships a read-only `navigator` global; only define our stub when
// it's genuinely absent (and via defineProperty, since plain assignment
// throws against the getter-only property).
if (typeof g.navigator === "undefined") {
  Object.defineProperty(g, "navigator", {
    value: { userAgent: "node", maxTouchPoints: 0, language: "en" },
    configurable: true,
  });
}
