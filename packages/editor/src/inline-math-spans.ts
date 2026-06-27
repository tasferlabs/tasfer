/**
 * Inline-math span detection — the leaf core of inline-math chip handling.
 *
 * Inline math is stored as a run of LaTeX characters tagged with the "math"
 * format but treated as a single atomic chip. `getInlineMathSpans` resolves a
 * block's chips to caret-edge ranges; `getCrossedInlineMathSpan` reports when a
 * caret move stepped across a chip's boundaries.
 *
 * Kept deliberately dependency-light (block-registry + char-runs only) so it can
 * be imported by `MathMark` without dragging in the `selection` → `state-utils`
 * → registry import chain — `MathMark` is constructed while that chain is still
 * initializing, so importing it there would be a load-order cycle. The richer,
 * geometry-aware helpers (`getInlineMathAtPosition`, snapping) live in
 * `./inline-math`, which builds on this module.
 */

import type { Block, Char, MarkSpan } from "./serlization/loadPage";
import { isTextualBlock } from "./sync/block-registry";
import { iterateAllChars } from "./sync/char-runs";

export interface InlineMathSpan {
  startIndex: number;
  endIndex: number;
  latex: string;
}

/**
 * A single mark's contiguous run resolved to caret-edge offsets — the
 * mark-agnostic generalization of {@link InlineMathSpan} that backs
 * `query.marks`. `startIndex`/`endIndex` are the caret-edge range (`endIndex` is
 * after the last surviving char); `text` is the run's visible text; `attrs` is
 * the mark's data (`{ url }` for a link, `{}` for a toggle mark).
 */
export interface MarkRunData {
  readonly name: string;
  readonly attrs: Record<string, unknown>;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly text: string;
}

/**
 * Resolve every mark run in a block to caret-edge offsets — the single source of
 * truth for "where does each mark render", shared by the inline-math chips and
 * `query.marks`.
 *
 * Endpoints are resolved *tolerantly*: a format span anchors to exact char IDs,
 * but those chars can be tombstoned (deleting a chip's leading char makes
 * `startCharId` a tombstone) while interior chars survive. We key off
 * document-order ordinals so a span resolves to its surviving visible chars
 * instead of vanishing when an endpoint is deleted. The render path
 * (`TextNode.replacementRuns`) resolves through the same core
 * ({@link resolveMarkRunsFromChars}), so painting and editing never disagree on
 * a chip's extent.
 */
export function resolveMarkRuns(block: Block): MarkRunData[] {
  if (!isTextualBlock(block)) return [];
  return resolveMarkRunsFromChars(
    iterateAllChars(block.charRuns),
    block.formats,
  );
}

/**
 * The {@link resolveMarkRuns} core, over a raw char sequence (document order,
 * tombstones included) and its format spans — so the render path (which holds a
 * resolved `Char[]`, not a `Block`) resolves chips through the SAME tolerant
 * logic as the edit/caret path, instead of its own strict char-id lookup that
 * dropped a whole chip the moment an endpoint char was tombstoned. `chars` must
 * include deleted chars so document-order ordinals line up with the span anchors.
 */
export function resolveMarkRunsFromChars(
  chars: Iterable<Char>,
  formats: MarkSpan[],
): MarkRunData[] {
  const ordinal = new Map<string, number>(); // char id → document-order position
  const visibleOrd: number[] = []; // ordinal of each visible char, ascending
  const visibleChars: string[] = []; // visible chars, to recover the run text
  let ord = 0;
  for (const { id, char, deleted } of chars) {
    ordinal.set(id, ord);
    if (!deleted) {
      visibleOrd.push(ord);
      visibleChars.push(char);
    }
    ord++;
  }

  const runs: MarkRunData[] = [];
  for (const span of formats) {
    const startOrd = ordinal.get(span.startCharId);
    const endOrd = ordinal.get(span.endCharId);
    if (startOrd === undefined || endOrd === undefined) continue;

    // Visible chars whose ordinal falls within the (possibly tombstoned)
    // endpoint range [startOrd, endOrd]. `visibleOrd` ascends, so the first such
    // index opens the span and the last closes it.
    let startIndex = -1;
    let endIndex = -1;
    for (let vi = 0; vi < visibleOrd.length; vi++) {
      if (visibleOrd[vi] < startOrd) continue;
      if (visibleOrd[vi] > endOrd) break;
      if (startIndex === -1) startIndex = vi;
      endIndex = vi;
    }
    if (startIndex === -1) continue; // every char in the span is deleted

    // Caret-edge range is [startIndex, endIndex + 1): startIndex before the
    // first surviving char, endIndex + 1 after the last.
    runs.push({
      name: span.format.type,
      attrs: span.format.attrs ?? {},
      startIndex,
      endIndex: endIndex + 1,
      text: visibleChars.slice(startIndex, endIndex + 1).join(""),
    });
  }
  return runs;
}

export function getInlineMathSpans(block: Block): InlineMathSpan[] {
  return resolveMarkRuns(block)
    .filter((r) => r.name === "math")
    .map((r) => ({
      startIndex: r.startIndex,
      endIndex: r.endIndex,
      latex: r.text,
    }));
}

/**
 * If a caret move from `prevTextIndex` to `newTextIndex` stepped across an
 * inline-math chip (between its opposite boundaries), return that span; else
 * null. Used to open the inline-math editor when an arrow key crosses a chip.
 */
export function getCrossedInlineMathSpan(
  block: Block,
  prevTextIndex: number,
  newTextIndex: number,
): InlineMathSpan | null {
  for (const span of getInlineMathSpans(block)) {
    if (
      (prevTextIndex === span.startIndex && newTextIndex === span.endIndex) ||
      (prevTextIndex === span.endIndex && newTextIndex === span.startIndex)
    ) {
      return span;
    }
  }
  return null;
}
