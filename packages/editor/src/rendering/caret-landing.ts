/**
 * Caret "landing" animation.
 *
 * When the insertion caret navigates to a new position (arrow keys, a click, a
 * selection collapse) it arrives as a small circle that squishes horizontally
 * and stretches vertically into the caret bar — a Mathematica-style flourish
 * that draws the eye to where the caret landed.
 *
 * These are pure geometry helpers so the morph can be unit-tested without a
 * canvas. The renderer feeds the resulting shape to `ctx.roundRect`.
 */

export interface CaretLandingShape {
  /** Half-width of the morphing capsule, in CSS pixels. */
  readonly halfWidth: number;
  /** Half-height of the morphing capsule, in CSS pixels. */
  readonly halfHeight: number;
  /** Corner radius of the capsule, in CSS pixels. */
  readonly cornerRadius: number;
}

/** easeOutCubic — quick arrival, gentle settle. */
function easeOutCubic(t: number): number {
  const c = 1 - t;
  return 1 - c * c * c;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * Raw (un-eased) progress of the landing animation in [0, 1]. Returns 1
 * ("finished") once `elapsed >= duration`, so callers can treat a result of 1
 * as "draw the plain caret". A non-positive `duration` disables the animation.
 */
export function caretLandingProgress(
  now: number,
  startedAt: number,
  duration: number,
): number {
  if (duration <= 0) return 1;
  const elapsed = now - startedAt;
  if (elapsed <= 0) return 0;
  if (elapsed >= duration) return 1;
  return elapsed / duration;
}

/**
 * Shape of the morphing caret at a given raw progress. At progress 0 it is a
 * circle of `radius` (clamped so a tall caret still starts from a proportionate
 * dot); at progress 1 it is the caret bar (`caretWidth` × `caretHeight`).
 * Intermediate values form a vertical capsule.
 */
export function caretLandingShape(
  progress: number,
  caretWidth: number,
  caretHeight: number,
  radius: number,
): CaretLandingShape {
  const p = easeOutCubic(Math.max(0, Math.min(1, progress)));
  const startRadius = Math.min(radius, caretHeight / 2);
  const halfWidth = lerp(startRadius, caretWidth / 2, p);
  const halfHeight = lerp(startRadius, caretHeight / 2, p);
  return {
    halfWidth,
    halfHeight,
    // The capsule radius tracks the (smaller) half-width so the ends stay fully
    // rounded through the morph and the final bar keeps crisp ~1px corners.
    cornerRadius: halfWidth,
  };
}
