/**
 * Mark-run resolution — where does each inline mark actually render.
 *
 * A format span anchors to exact char IDs, but those chars can be tombstoned
 * (deleting a run's leading char makes `startCharId` a tombstone) while interior
 * chars survive. Resolving *tolerantly* — by document-order ordinal rather than
 * by strict char-id lookup — is what keeps a run visible instead of vanishing
 * when an endpoint is deleted.
 *
 * This is the single source of truth shared by `query.marks`, the render path
 * (`TextNode.replacementRuns`), and any feature that resolves its own mark to
 * caret-edge offsets (inline math's chips build on it from
 * `@tasfer/math`). Mark-agnostic by design: it knows about spans and
 * chars, never about a particular mark type.
 *
 * Kept deliberately dependency-light (block-registry + char-runs only) so a
 * `Mark` subclass can import it during construction, while the `selection` →
 * `state-utils` → registry chain is still initializing, without a load-order
 * cycle.
 */

import type { Block, Char, MarkSpan } from "./serlization/loadPage";
import { isTextualBlock } from "./sync/block-registry";
import { iterateAllChars } from "./sync/char-runs";

/**
 * A single mark's contiguous run resolved to caret-edge offsets.
 * `startIndex`/`endIndex` are the caret-edge range (`endIndex` is after the last
 * surviving char); `text` is the run's visible text; `attrs` is the mark's data
 * (`{ url }` for a link, `{}` for a toggle mark).
 */
export interface MarkRunData {
  readonly name: string;
  readonly attrs: Record<string, unknown>;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly text: string;
}

/**
 * Resolve every mark run in a block to caret-edge offsets. The render path
 * resolves through the same core ({@link resolveMarkRunsFromChars}), so painting
 * and editing never disagree on a run's extent.
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
 * resolved `Char[]`, not a `Block`) resolves runs through the SAME tolerant
 * logic as the edit/caret path. `chars` must include deleted chars so
 * document-order ordinals line up with the span anchors.
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
