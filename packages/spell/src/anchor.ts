/**
 * Character anchors — turning visible text offsets into CRDT-stable
 * decoration endpoints.
 *
 * A spell flag arrives from the worker as `[from, to)` offsets into the
 * block's visible text as it was when the check was sent. By the time the
 * squiggle is painted the user may have typed ahead of the word, so the
 * checker anchors every flag to character identities instead: the core
 * resolves a {@link CharacterDecorationPoint} at paint time by walking the
 * block's live char runs, so an insertion before the word shifts the
 * squiggle and an edit inside the word shrinks or drops it.
 *
 * Character ids follow the core's encoding exactly —
 * `${run.peerId}:${run.startCounter + offsetInRun}` — and deleted characters
 * (bit `i` of `deletedMask`) are skipped, mirroring the core's
 * `getVisibleOffsetAfterChar`. Everything here is a pure function over the
 * public {@link Block} shape; no editor instance is touched.
 */

import type {
  Block,
  CharacterDecorationPoint,
  DecorationRange,
} from "@tasfer/editor";

/** The char-run shape shared by every text-bearing block (structural copy of the core's `CharRun`). */
interface RawCharRun {
  readonly peerId: string;
  readonly startCounter: number;
  readonly text: string;
  readonly deletedMask?: readonly number[];
}

function charRunsOf(block: Block): readonly RawCharRun[] | null {
  const runs = (block as { charRuns?: unknown }).charRuns;
  return Array.isArray(runs) ? (runs as RawCharRun[]) : null;
}

function isCharDeleted(run: RawCharRun, offset: number): boolean {
  const mask = run.deletedMask;
  if (!mask) return false;
  const byte = mask[Math.floor(offset / 8)];
  return byte !== undefined && (byte & (1 << (offset % 8))) !== 0;
}

/**
 * Ids of the visible character before each of `offsets` (ascending, visible
 * UTF-16 offsets). Offset `0` (or a block without char runs) yields `null`;
 * an offset past the end yields the last visible char. One pass over the runs.
 */
export function anchorIds(
  block: Block,
  offsets: readonly number[],
): (string | null)[] {
  const out: (string | null)[] = new Array(offsets.length).fill(null);
  const runs = charRunsOf(block);
  if (!runs || offsets.length === 0) return out;

  let i = 0;
  while (i < offsets.length && offsets[i] <= 0) i++;
  if (i >= offsets.length) return out;

  let visible = 0;
  let lastId: string | null = null;
  for (const run of runs) {
    for (let k = 0; k < run.text.length; k++) {
      if (isCharDeleted(run, k)) continue;
      visible += 1;
      lastId = `${run.peerId}:${run.startCounter + k}`;
      while (i < offsets.length && offsets[i] <= visible) {
        out[i] = lastId;
        i++;
      }
      if (i >= offsets.length) return out;
    }
  }
  // Offsets past the visible end clamp to the last visible character.
  for (; i < offsets.length; i++) out[i] = lastId;
  return out;
}

/**
 * The stable gap at visible `offset` in `block`: `{ blockId, afterCharId }`
 * where `afterCharId` is the id of the visible character at `offset - 1`, or
 * `null` at the start of the block.
 */
export function charAnchor(
  block: Block,
  offset: number,
): CharacterDecorationPoint {
  const [afterCharId] = anchorIds(block, [Math.max(0, Math.trunc(offset))]);
  return { blockId: block.id, afterCharId: afterCharId ?? null };
}

/**
 * Anchor the visible span `[from, to)` of `block`. `to` is anchored to the
 * word's LAST character, so deleting it collapses the painted range.
 */
export function anchorRange(
  block: Block,
  from: number,
  to: number,
): DecorationRange {
  const [r] = anchorRanges(block, [{ from, to }]);
  return r;
}

/**
 * Batch form of {@link anchorRange}: anchors every span with a single walk of
 * the block's runs (spans need not be sorted; output order matches input).
 */
export function anchorRanges(
  block: Block,
  spans: ReadonlyArray<{ readonly from: number; readonly to: number }>,
): DecorationRange[] {
  const offsets: number[] = [];
  for (const s of spans) offsets.push(s.from, s.to);
  const order = offsets
    .map((_, i) => i)
    .sort((a, b) => offsets[a] - offsets[b]);
  const sorted = order.map((i) => offsets[i]);
  const ids = anchorIds(block, sorted);
  const byIndex: (string | null)[] = new Array(offsets.length);
  order.forEach((originalIndex, sortedIndex) => {
    byIndex[originalIndex] = ids[sortedIndex];
  });
  return spans.map((_, i) => ({
    from: { blockId: block.id, afterCharId: byIndex[i * 2] },
    to: { blockId: block.id, afterCharId: byIndex[i * 2 + 1] },
  }));
}

/**
 * Index of a block's LIVE characters: char id → visible offset just after
 * that character. Deleted characters are absent, so a lookup miss means the
 * anchor no longer stands. Build once per block, then resolve many anchors
 * with {@link resolveAnchoredRange}.
 */
export function charOffsetIndex(block: Block): Map<string, number> {
  const index = new Map<string, number>();
  const runs = charRunsOf(block);
  if (!runs) return index;
  let visible = 0;
  for (const run of runs) {
    for (let k = 0; k < run.text.length; k++) {
      if (isCharDeleted(run, k)) continue;
      visible += 1;
      index.set(`${run.peerId}:${run.startCounter + k}`, visible);
    }
  }
  return index;
}

/**
 * Current visible `[from, to)` of an anchored range, or `null` when either
 * anchor character was deleted (the word changed) or the range is not
 * character-anchored. Strict on purpose: the core's paint-time resolver
 * tolerates a deleted anchor by sliding to its gap, but for spellcheck a word
 * whose boundary character is gone is stale and must not be acted on.
 */
export function resolveAnchoredRange(
  index: ReadonlyMap<string, number>,
  range: DecorationRange,
): { from: number; to: number } | null {
  const from = resolveAnchor(index, range.from);
  const to = resolveAnchor(index, range.to);
  if (from === null || to === null || to < from) return null;
  return { from, to };
}

function resolveAnchor(
  index: ReadonlyMap<string, number>,
  point: DecorationRange["from"],
): number | null {
  if (!("afterCharId" in point)) return null;
  if (point.afterCharId === null) return 0;
  return index.get(point.afterCharId) ?? null;
}

/** The live (non-tombstoned) raw block with `id`, or `null`. */
export function findRawBlock(
  blocks: readonly Block[],
  id: string,
): Block | null {
  for (const b of blocks) {
    if (b.id === id) return b.deleted ? null : b;
  }
  return null;
}
