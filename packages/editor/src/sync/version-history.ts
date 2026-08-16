/**
 * Version History
 *
 * Turns a page's operation log into a short list of *meaningful* revert points.
 *
 * The naive approach — sample every Nth operation — produces boundaries that
 * have nothing to do with what changed: on a long-lived page each entry spans
 * dozens of unrelated edits, on a fresh page nearly every keystroke becomes its
 * own entry, and neither can be labelled with anything more useful than an
 * index. This module instead cuts the log where a human would say the work
 * changed, and only keeps a cut when enough actually happened across it.
 *
 * Three passes, none of which replay the reducer:
 *
 *  1. **Segment.** Cut between two operations when the author changes, when the
 *     page sat idle, or when a run of meaningful block deletions starts or
 *     ends. A continuous typing burst stays one candidate.
 *  2. **Score and coalesce.** Weigh each candidate by how much it changed and
 *     fold anything below the bar forward into the next candidate, so a typo
 *     fix never earns its own row. The bar scales with page size — one added
 *     block is an event on a five-block page and noise on a five-hundred-block
 *     one — and deletions bypass it entirely, because undoing a deletion is the
 *     single most common reason anyone opens version history.
 *  3. **Classify.** Describe each surviving entry from its own counters, so the
 *     host can render "deleted 12 blocks" instead of "version 7".
 *
 * Block content is deliberately *not* built here. Materializing every entry's
 * blocks costs a full reducer replay per entry and is wasted for every entry
 * the user does not open; {@link materializeVersion} does that for one entry,
 * on demand.
 */

import type { Page } from "../serlization/loadPage";
import type { HLC, Operation, TextInsert } from "../state-types";
import { sortBlocksByOrder } from "./block-order";
import { applyOp, createEmptyPageState } from "./reducer";
import type { DataSchema } from "./schema";

// =============================================================================
// Types
// =============================================================================

/** One persisted operation paired with the wall-clock time it was recorded. */
export interface TimedOperation {
  readonly op: Operation;
  /** ms since epoch. 0 when unknown (rows persisted before timestamps). */
  readonly timestamp: number;
}

/** How much an entry changed, counted straight off its operations. */
export interface VersionChange {
  /** Blocks that came into existence in this entry. */
  readonly blocksAdded: number;
  /** Live blocks that were tombstoned in this entry. */
  readonly blocksRemoved: number;
  /** Blocks whose type was morphed (paragraph → heading, list → todo, …). */
  readonly blocksRetyped: number;
  /** Blocks repositioned in the document order. */
  readonly blocksMoved: number;
  readonly charsInserted: number;
  readonly charsDeleted: number;
  /** Mark applications/removals (bold, link, …). */
  readonly marksChanged: number;
  /** Mutations to structured attachments (math, and other embedded documents). */
  readonly structuredEdits: number;
  /** Distinct blocks touched in any way. */
  readonly blocksTouched: number;
}

/**
 * The shape of an entry's change, for labelling. Deliberately coarse: the host
 * turns this plus {@link VersionChange} into a localized sentence, and every
 * extra kind is another sentence somebody has to translate.
 */
export type VersionKind =
  /** The entry that brought the page into existence. */
  | "created"
  /** Dominated by removal. */
  | "deletion"
  /** Wholesale replacement of everything that was live — a restore or a paste-over. */
  | "replaced"
  /** New blocks, little removal. */
  | "addition"
  /** Existing text substantially reworked in place. */
  | "rewrite"
  /** Only marks changed. */
  | "formatting"
  /** Anything else. */
  | "edit";

/** One offered revert point. */
export interface VersionEntry {
  /** Stable within a log: the HLC of the entry's last operation. */
  readonly id: string;
  readonly clock: HLC;
  /**
   * Index of the entry's last operation in the array it was built from. Pass it
   * to {@link materializeVersion} to build this entry's blocks.
   */
  readonly opIndex: number;
  /** Operations in the log up to and including this entry. */
  readonly opCount: number;
  /** Operations belonging to this entry alone. */
  readonly opSpan: number;
  /** Wall-clock time of the entry's last operation (0 when unknown). */
  readonly createdAt: number;
  /** Wall-clock time of the entry's first operation (0 when unknown). */
  readonly startedAt: number;
  /** Peers that contributed, most-active first. */
  readonly peerIds: readonly string[];
  /** Live block count once this entry landed. */
  readonly blockCount: number;
  readonly change: VersionChange;
  readonly kind: VersionKind;
  /**
   * Text this entry introduced that best names it — the content of the block it
   * created that `blockSubjectPriority` ranks highest. Absent when the entry
   * created nothing with text.
   */
  readonly subject?: string;
}

export interface VersionHistoryOptions {
  /**
   * Silence, in ms, that ends an editing session. Default 3 minutes: long
   * enough to survive thinking mid-paragraph, short enough that picking the
   * document back up after lunch starts a new entry.
   */
  readonly idleGapMs?: number;
  /**
   * Change weight an entry must carry to stand on its own, at
   * {@link BASELINE_BLOCKS} blocks. Roughly "two dozen typed characters".
   */
  readonly significance?: number;
  /**
   * Entries to return at most. Exceeding it re-runs the fold at a higher bar
   * rather than truncating, so the list thins out evenly instead of losing all
   * its history.
   */
  readonly maxEntries?: number;
  /**
   * Ranks a created block's type as a source for {@link VersionEntry.subject};
   * higher wins, ties break on text length. The core has no idea which of a
   * host's block types reads as a title, so by default nothing is preferred and
   * the longest inserted text wins.
   */
  readonly blockSubjectPriority?: (blockType: string) => number;
}

// =============================================================================
// Tuning
// =============================================================================

const DEFAULT_IDLE_GAP_MS = 3 * 60 * 1000;
const DEFAULT_SIGNIFICANCE = 24;
const DEFAULT_MAX_ENTRIES = 60;

/** Page size at which `significance` applies unscaled. */
const BASELINE_BLOCKS = 12;
/** Ceiling on the page-size scaling, so huge pages still offer entries. */
const MAX_SIGNIFICANCE_SCALE = 8;

/**
 * Characters a block must hold for its deletion to read as losing something.
 * Below this, a `block_delete` is punctuation — backspacing an empty line,
 * joining two paragraphs — and must not fragment the surrounding session.
 */
const MEANINGFUL_BLOCK_CHARS = 8;

/** Longest `subject` kept; the rest is the host's to truncate for display. */
const MAX_SUBJECT_CHARS = 80;

/**
 * Characters tracked per candidate-created block while reassembling its text.
 * A subject only ever shows {@link MAX_SUBJECT_CHARS}; the slack is there so
 * ties break on something closer to the real length than the visible prefix.
 */
const MAX_TRACKED_CHARS = 240;

const WEIGHT = {
  charInserted: 1,
  charDeleted: 1.5,
  blockAdded: 12,
  blockRemoved: 30,
  blockRetyped: 8,
  blockMoved: 6,
  markChanged: 0.5,
  structuredEdit: 4,
} as const;

// =============================================================================
// Segmentation
// =============================================================================

interface MutableChange {
  blocksAdded: number;
  blocksRemoved: number;
  blocksRetyped: number;
  blocksMoved: number;
  charsInserted: number;
  charsDeleted: number;
  marksChanged: number;
  structuredEdits: number;
}

/** One character of a block being reassembled, in document order. */
interface TrackedChar {
  readonly id: string;
  readonly ch: string;
  deleted: boolean;
}

/** A block created inside a candidate, with the text typed into it so far. */
interface BornBlock {
  blockType: string;
  readonly chars: TrackedChar[];
}

interface Candidate {
  startIndex: number;
  endIndex: number;
  startedAt: number;
  createdAt: number;
  clock: HLC;
  /** peerId -> operations contributed. */
  peers: Map<string, number>;
  touched: Set<string>;
  change: MutableChange;
  /** Live blocks once this candidate landed. */
  blockCount: number;
  /** Live blocks before it started — the denominator for "replaced". */
  blockCountBefore: number;
  /** Holds a deletion of a block that had real content. */
  destructive: boolean;
  /** Blocks this candidate created, keyed by id. Emptied once named. */
  born: Map<string, BornBlock>;
  subject?: string;
  subjectPriority: number;
  subjectLength: number;
}

function emptyChange(): MutableChange {
  return {
    blocksAdded: 0,
    blocksRemoved: 0,
    blocksRetyped: 0,
    blocksMoved: 0,
    charsInserted: 0,
    charsDeleted: 0,
    marksChanged: 0,
    structuredEdits: 0,
  };
}

function charsInOp(op: Operation): number {
  if (op.op !== "text_insert") return 0;
  let n = 0;
  for (const run of op.charRuns) n += run.text.length;
  return n;
}

/**
 * Splices an insert into the text of a block this candidate created.
 *
 * Typing arrives one operation per keystroke, so a subject can only be read off
 * the *assembled* block: each op carries the character it landed after, and
 * replaying those anchors is what turns forty ops into "Release notes" instead
 * of "s". An anchor this candidate never saw — text appended to a block whose
 * earlier characters fell outside the tracked window — lands at the end, which
 * is where continued typing goes anyway.
 */
function insertTracked(born: BornBlock, op: TextInsert): void {
  const chars = born.chars;
  let at = chars.length;
  if (op.afterCharId === null) {
    at = 0;
  } else {
    // Typing anchors on the character it just wrote, so search from the back.
    for (let i = chars.length - 1; i >= 0; i--) {
      if (chars[i].id === op.afterCharId) {
        at = i + 1;
        break;
      }
    }
  }

  for (const run of op.charRuns) {
    for (let i = 0; i < run.text.length; i++) {
      if (chars.length >= MAX_TRACKED_CHARS) return;
      chars.splice(at, 0, {
        id: `${run.peerId}:${run.startCounter + i}`,
        ch: run.text[i],
        deleted: false,
      });
      at++;
    }
  }
}

function deleteTracked(born: BornBlock, charIds: readonly string[]): void {
  if (born.chars.length === 0) return;
  const removed = new Set(charIds);
  for (const char of born.chars) {
    if (removed.has(char.id)) char.deleted = true;
  }
}

/** The block's surviving text, flattened onto one line for a label. */
function trackedText(born: BornBlock): string {
  let text = "";
  for (const char of born.chars) if (!char.deleted) text += char.ch;
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Names a candidate after the best block it created, once all of its operations
 * have landed. Deferred to the end of the candidate rather than decided per
 * operation, because a block's text is only complete when its last keystroke is.
 */
function nameCandidate(
  candidate: Candidate,
  subjectPriority: (blockType: string) => number,
): void {
  for (const born of candidate.born.values()) {
    const text = trackedText(born);
    if (text.length === 0) continue;
    const priority = subjectPriority(born.blockType);
    if (
      priority > candidate.subjectPriority ||
      (priority === candidate.subjectPriority &&
        text.length > candidate.subjectLength)
    ) {
      candidate.subject = text.slice(0, MAX_SUBJECT_CHARS);
      candidate.subjectPriority = priority;
      candidate.subjectLength = text.length;
    }
  }
  candidate.born.clear();
}

/**
 * Marks every operation that belongs to a *meaningful deletion run* — a maximal
 * stretch of consecutive `block_delete`s that, taken together, loses something.
 *
 * Runs, not individual ops: deleting a selection walks through whatever blocks
 * it covers, long and short alike, and judging each op on its own would cut the
 * session apart at every short one. A run counts as meaningful when it takes out
 * a block holding real text, or clears more than one live block at once —
 * anything smaller is punctuation (backspacing a blank line, joining two
 * paragraphs) and must not fragment the work around it.
 */
function markDeletionRuns(ops: readonly TimedOperation[]): boolean[] {
  const flags = new Array<boolean>(ops.length).fill(false);
  const live = new Set<string>();
  const charsPerBlock = new Map<string, number>();

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i].op;

    if (op.op === "block_insert") {
      live.add(op.blockId);
      continue;
    }
    if (op.op === "text_insert") {
      charsPerBlock.set(
        op.blockId,
        (charsPerBlock.get(op.blockId) ?? 0) + charsInOp(op),
      );
      continue;
    }
    if (op.op === "text_delete") {
      const remaining =
        (charsPerBlock.get(op.blockId) ?? 0) - op.charIds.length;
      charsPerBlock.set(op.blockId, Math.max(0, remaining));
      continue;
    }
    if (op.op !== "block_delete") continue;

    // Consume the whole run at once, then judge it as a unit.
    const start = i;
    let removed = 0;
    let lostContent = false;
    while (i < ops.length && ops[i].op.op === "block_delete") {
      const target = (ops[i].op as { blockId: string }).blockId;
      if (live.delete(target)) {
        removed++;
        if ((charsPerBlock.get(target) ?? 0) >= MEANINGFUL_BLOCK_CHARS) {
          lostContent = true;
        }
      }
      i++;
    }
    i--; // the outer loop re-increments

    if (lostContent || removed > 1) {
      for (let j = start; j <= i; j++) flags[j] = true;
    }
  }

  return flags;
}

/**
 * Walks the log once, tracking just enough live state (which blocks exist, how
 * much text each holds) to decide where sessions break and how big each one is.
 * No reducer, no block materialization.
 */
function collectCandidates(
  ops: readonly TimedOperation[],
  idleGapMs: number,
  subjectPriority: (blockType: string) => number,
): Candidate[] {
  const live = new Set<string>();
  const charsPerBlock = new Map<string, number>();
  const inDeletionRun = markDeletionRuns(ops);

  const candidates: Candidate[] = [];
  let current: Candidate | null = null;
  let prev: { peerId: string; timestamp: number; destructive: boolean } | null =
    null;

  for (let i = 0; i < ops.length; i++) {
    const { op, timestamp } = ops[i];
    const peerId = op.clock.peerId;
    const destructive = inDeletionRun[i];

    const idle =
      prev !== null &&
      prev.timestamp > 0 &&
      timestamp > 0 &&
      timestamp - prev.timestamp > idleGapMs;

    const cut =
      current === null ||
      prev === null ||
      peerId !== prev.peerId ||
      idle ||
      destructive !== prev.destructive;

    if (cut) {
      if (current) nameCandidate(current, subjectPriority);
      current = {
        startIndex: i,
        endIndex: i,
        startedAt: timestamp,
        createdAt: timestamp,
        clock: op.clock,
        peers: new Map(),
        touched: new Set(),
        change: emptyChange(),
        blockCount: live.size,
        blockCountBefore: live.size,
        destructive: false,
        born: new Map(),
        subjectPriority: -Infinity,
        subjectLength: 0,
      };
      candidates.push(current);
    }

    const entry = current!;
    entry.endIndex = i;
    entry.clock = op.clock;
    if (timestamp > 0) entry.createdAt = timestamp;
    if (entry.startedAt === 0 && timestamp > 0) entry.startedAt = timestamp;
    entry.peers.set(peerId, (entry.peers.get(peerId) ?? 0) + 1);
    entry.touched.add(op.blockId);
    if (destructive) entry.destructive = true;

    switch (op.op) {
      case "block_insert": {
        if (!live.has(op.blockId)) {
          live.add(op.blockId);
          entry.change.blocksAdded++;
          entry.born.set(op.blockId, { blockType: op.blockType, chars: [] });
        }
        break;
      }
      case "block_delete": {
        if (live.delete(op.blockId)) {
          entry.change.blocksRemoved++;
          entry.born.delete(op.blockId);
        }
        break;
      }
      case "block_set": {
        if (op.field === "type") {
          entry.change.blocksRetyped++;
          const born = entry.born.get(op.blockId);
          if (born) born.blockType = String(op.value);
        } else if (op.field === "orderKey") {
          entry.change.blocksMoved++;
        }
        break;
      }
      case "text_insert": {
        const n = charsInOp(op);
        entry.change.charsInserted += n;
        charsPerBlock.set(op.blockId, (charsPerBlock.get(op.blockId) ?? 0) + n);
        // Only text landing in a block this candidate created can name it; text
        // typed into a pre-existing block describes an edit, not a subject.
        const born = entry.born.get(op.blockId);
        if (born) insertTracked(born, op);
        break;
      }
      case "text_delete": {
        entry.change.charsDeleted += op.charIds.length;
        const born = entry.born.get(op.blockId);
        if (born) deleteTracked(born, op.charIds);
        const remaining =
          (charsPerBlock.get(op.blockId) ?? 0) - op.charIds.length;
        charsPerBlock.set(op.blockId, Math.max(0, remaining));
        break;
      }
      case "mark_set": {
        entry.change.marksChanged++;
        break;
      }
      case "content_edit": {
        entry.change.structuredEdits++;
        break;
      }
    }

    entry.blockCount = live.size;
    prev = { peerId, timestamp, destructive };
  }

  if (current) nameCandidate(current, subjectPriority);
  return candidates;
}

/**
 * Rejoins the two halves of a wholesale replacement.
 *
 * Restoring an older version — or pasting over everything — is emitted as
 * "delete every live block, then insert the new ones", and the deletion-run cut
 * lands squarely in the middle of it. Left split, the history claims the page
 * was emptied and then refilled, and offers the momentarily-blank page as a
 * revert point nobody ever meant to create.
 */
function fuseReplacements(
  candidates: Candidate[],
  idleGapMs: number,
): Candidate[] {
  const fused: Candidate[] = [];

  for (const candidate of candidates) {
    const previous = fused[fused.length - 1];
    const clearedThePage =
      previous !== undefined &&
      previous.blockCount === 0 &&
      previous.blockCountBefore > 0 &&
      previous.change.blocksRemoved > 0;
    const refills = candidate.change.blocksAdded > 0;
    // Candidates are already cut on author and idle time, so "same session"
    // means one peer and no silence across the seam.
    const previousPeer = previous && onlyPeer(previous);
    const continuous =
      previous !== undefined &&
      previousPeer !== null &&
      previousPeer === onlyPeer(candidate) &&
      (previous.createdAt === 0 ||
        candidate.startedAt === 0 ||
        candidate.startedAt - previous.createdAt <= idleGapMs);

    if (clearedThePage && refills && continuous) {
      absorb(previous, candidate);
      continue;
    }
    fused.push(candidate);
  }

  return fused;
}

function onlyPeer(candidate: Candidate): string | null {
  const [first] = candidate.peers.keys();
  return candidate.peers.size === 1 ? (first ?? null) : null;
}

// =============================================================================
// Scoring
// =============================================================================

function weigh(change: MutableChange): number {
  return (
    change.charsInserted * WEIGHT.charInserted +
    change.charsDeleted * WEIGHT.charDeleted +
    change.blocksAdded * WEIGHT.blockAdded +
    change.blocksRemoved * WEIGHT.blockRemoved +
    change.blocksRetyped * WEIGHT.blockRetyped +
    change.blocksMoved * WEIGHT.blockMoved +
    change.marksChanged * WEIGHT.markChanged +
    change.structuredEdits * WEIGHT.structuredEdit
  );
}

/**
 * The bar an entry must clear, scaled by how much page there is to change.
 * Adding a block to a five-block page is the page doubling; adding one to a
 * five-hundred-block page is a line of housekeeping.
 */
function thresholdFor(baseline: number, blockCount: number): number {
  const scale = Math.min(
    MAX_SIGNIFICANCE_SCALE,
    Math.max(1, Math.sqrt(blockCount / BASELINE_BLOCKS)),
  );
  return baseline * scale;
}

/**
 * Fold `source` into `target`. `source` always immediately follows `target` in
 * the log, so the merged candidate inherits its endpoint — its last operation,
 * its clock, its timestamp and the block count it left behind.
 */
function absorb(target: Candidate, source: Candidate): void {
  target.endIndex = source.endIndex;
  target.clock = source.clock;
  target.blockCount = source.blockCount;
  if (source.createdAt > 0) target.createdAt = source.createdAt;
  if (target.startedAt === 0) target.startedAt = source.startedAt;
  for (const [peer, count] of source.peers) {
    target.peers.set(peer, (target.peers.get(peer) ?? 0) + count);
  }
  for (const id of source.touched) target.touched.add(id);
  target.change.blocksAdded += source.change.blocksAdded;
  target.change.blocksRemoved += source.change.blocksRemoved;
  target.change.blocksRetyped += source.change.blocksRetyped;
  target.change.blocksMoved += source.change.blocksMoved;
  target.change.charsInserted += source.change.charsInserted;
  target.change.charsDeleted += source.change.charsDeleted;
  target.change.marksChanged += source.change.marksChanged;
  target.change.structuredEdits += source.change.structuredEdits;
  target.destructive ||= source.destructive;
  if (
    source.subject !== undefined &&
    (source.subjectPriority > target.subjectPriority ||
      (source.subjectPriority === target.subjectPriority &&
        source.subjectLength > target.subjectLength))
  ) {
    target.subject = source.subject;
    target.subjectPriority = source.subjectPriority;
    target.subjectLength = source.subjectLength;
  }
}

/**
 * Folds sub-threshold candidates *forward* into the one that follows. Forward,
 * not backward: a change too small to be its own revert point still belongs to
 * the work that came after it, and reverting to a point mid-way through nothing
 * meaningful is exactly what this list is trying to stop offering.
 *
 * Never folded away: the first candidate (the page has to be reachable at its
 * origin), the last (the current state has to be reachable), and anything
 * holding a real deletion.
 *
 * Accumulates into copies, never into `candidates` itself — the caller re-runs
 * this at successively higher bars to fit `maxEntries`, and a pass that folded
 * in place would hand the next one a log that had already counted itself twice.
 */
function coalesce(candidates: Candidate[], baseline: number): Candidate[] {
  const kept: Candidate[] = [];
  let pending: Candidate | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (pending) absorb(pending, candidate);
    else pending = cloneCandidate(candidate);

    // The origin and the current state must always be reachable, and a real
    // deletion is the whole reason this list exists.
    const forced =
      pending.destructive || i === 0 || i === candidates.length - 1;

    if (
      forced ||
      weigh(pending.change) >= thresholdFor(baseline, pending.blockCount)
    ) {
      kept.push(pending);
      pending = null;
    }
  }

  // Only reachable if the loop never ran; the last candidate is always forced.
  if (pending) kept.push(pending);
  return kept;
}

function cloneCandidate(candidate: Candidate): Candidate {
  return {
    ...candidate,
    peers: new Map(candidate.peers),
    touched: new Set(candidate.touched),
    born: new Map(candidate.born),
    change: { ...candidate.change },
  };
}

// =============================================================================
// Classification
// =============================================================================

function classify(candidate: Candidate, isFirst: boolean): VersionKind {
  const c = candidate.change;

  if (isFirst) return "created";

  if (
    c.blocksRemoved > 0 &&
    candidate.blockCountBefore > 0 &&
    c.blocksRemoved >= candidate.blockCountBefore &&
    c.blocksAdded > 0
  ) {
    return "replaced";
  }

  if (c.blocksRemoved > c.blocksAdded) return "deletion";
  if (c.blocksAdded > c.blocksRemoved && c.charsInserted >= c.charsDeleted) {
    return "addition";
  }
  if (c.charsInserted > 0 && c.charsDeleted >= c.charsInserted * 0.6) {
    return "rewrite";
  }
  if (
    c.marksChanged > 0 &&
    c.charsInserted === 0 &&
    c.charsDeleted === 0 &&
    c.blocksAdded === 0 &&
    c.blocksRemoved === 0 &&
    c.blocksRetyped === 0
  ) {
    return "formatting";
  }
  return "edit";
}

function toEntry(candidate: Candidate, isFirst: boolean): VersionEntry {
  const peerIds = [...candidate.peers.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([peerId]) => peerId);

  return {
    id: `${candidate.clock.counter}-${candidate.clock.peerId}`,
    clock: candidate.clock,
    opIndex: candidate.endIndex,
    opCount: candidate.endIndex + 1,
    opSpan: candidate.endIndex - candidate.startIndex + 1,
    createdAt: candidate.createdAt,
    startedAt: candidate.startedAt || candidate.createdAt,
    peerIds,
    blockCount: candidate.blockCount,
    change: {
      ...candidate.change,
      blocksTouched: candidate.touched.size,
    },
    kind: classify(candidate, isFirst),
    ...(candidate.subject !== undefined ? { subject: candidate.subject } : {}),
  };
}

// =============================================================================
// Entry points
// =============================================================================

/**
 * Derive the revert points offered for a page, oldest first.
 *
 * `ops` must be the page's full operation log in the order it is replayed
 * (HLC order); {@link VersionEntry.opIndex} indexes back into that same array.
 */
export function buildVersionHistory(
  ops: readonly TimedOperation[],
  options: VersionHistoryOptions = {},
): VersionEntry[] {
  if (ops.length === 0) return [];

  const idleGapMs = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const subjectPriority = options.blockSubjectPriority ?? (() => 0);

  const candidates = fuseReplacements(
    collectCandidates(ops, idleGapMs, subjectPriority),
    idleGapMs,
  );

  // Raise the bar until the list fits rather than truncating it: dropping the
  // tail would silently amputate a page's early history, while re-folding just
  // makes the whole timeline coarser.
  let baseline = options.significance ?? DEFAULT_SIGNIFICANCE;
  let kept = coalesce(candidates, baseline);
  for (let attempt = 0; kept.length > maxEntries && attempt < 12; attempt++) {
    baseline *= 1.6;
    kept = coalesce(candidates, baseline);
  }
  // Deletions are unfoldable, so a page that is mostly deletions can still
  // overflow. Keep the most recent ones — the oldest revert points are the
  // least likely to be wanted.
  if (kept.length > maxEntries) kept = kept.slice(kept.length - maxEntries);

  return kept.map((candidate, index) => toEntry(candidate, index === 0));
}

/**
 * Replay the log up to and including `opIndex` and return the page state there.
 *
 * Operations arrive in HLC order, which is not causal order: a `text_delete`
 * can be replayed before the `text_insert` that created the characters it
 * names, and applying it then would drop the delete on the floor and leave the
 * text visible in a version it was absent from. Such deletes are held back and
 * folded in at the end, when their targets exist.
 */
export function materializeVersion(
  ops: readonly Operation[],
  opIndex: number,
  schema?: DataSchema,
): Page {
  const pageId = ops[0]?.pageId ?? "";
  let state = createEmptyPageState(pageId);

  const insertedCharIds = new Set<string>();
  const deferred: Operation[] = [];
  const end = Math.min(opIndex, ops.length - 1);

  for (let i = 0; i <= end; i++) {
    const op = ops[i];

    if (op.op === "text_insert") {
      for (const run of op.charRuns) {
        for (let j = 0; j < run.text.length; j++) {
          insertedCharIds.add(`${run.peerId}:${run.startCounter + j}`);
        }
      }
    }

    if (
      op.op === "text_delete" &&
      !op.charIds.every((id) => insertedCharIds.has(id))
    ) {
      deferred.push(op);
    } else {
      state = applyOp(state, op, schema);
    }
  }

  for (const op of deferred) state = applyOp(state, op, schema);
  return { ...state, blocks: sortBlocksByOrder(state.blocks) };
}
