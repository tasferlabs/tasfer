/**
 * Per-browser app-load counter, used to hold promotional popovers back from a
 * visitor's first impression. This is only for local gating, not analytics.
 *
 * markVisit() is called once at bootstrap (main.tsx); popovers read
 * getVisitCount() to decide eligibility, e.g. "show from the second load on".
 */

const KEY = "tasfer-visit-count";

/** Guards against a double bump within one page load (HMR / repeat bootstrap). */
let bumped = false;

export function markVisit(): void {
  if (bumped) return;
  bumped = true;
  try {
    const n = parseInt(window.localStorage.getItem(KEY) || "0", 10) || 0;
    window.localStorage.setItem(KEY, String(n + 1));
  } catch {
    // Storage unavailable — visit gating simply never advances.
  }
}

export function getVisitCount(): number {
  try {
    return parseInt(window.localStorage.getItem(KEY) || "0", 10) || 0;
  } catch {
    return 0;
  }
}
