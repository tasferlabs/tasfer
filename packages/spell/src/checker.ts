/**
 * SpellChecker — the per-editor controller.
 *
 * One instance per editor. It listens to the editor's change stream, decides
 * which blocks need (re)checking and how urgently, ships their text to a
 * {@link SpellTransport} (a worker, usually), anchors the returned flags to
 * CRDT character ids and publishes them as wavy-underline range decorations
 * on one layer. It also answers the UI's questions: the flag under a point,
 * flag just behind a point, next/previous flag, suggestions (cached), ignore-once, and a live count.
 *
 * Nothing here touches the DOM or React and there is no module-level state:
 * timers, caches, versions and flags all live on the instance, so several
 * editors on one page each run their own checker.
 *
 * Scheduling in short:
 *   - local edit  → caret block after `debounceMs.caret`, other blocks after
 *                   `debounceMs.local`; typing a boundary char (space,
 *                   punctuation, newline) flushes the caret block at once;
 *   - remote edit → after `debounceMs.remote`;
 *   - start / invalidateAll → full pass: caret block, then blocks near the
 *                   viewport, then the rest, 20 blocks per request;
 *   - publishing is coalesced per animation frame (~4/s during the full pass).
 *
 * The word under a caret that got there BY TYPING is not painted until
 * `caretGraceMs` after the last keystroke, so a half-typed word never flashes
 * red. A caret placed by click/arrow does not suppress anything.
 */

import {
  anchorRanges,
  charOffsetIndex,
  findRawBlock,
  resolveAnchoredRange,
  type TextFieldAddress,
} from "./anchor";
import type {
  CheckBlock,
  CheckedBlock,
  CheckPriority,
  Flag,
  Script,
  SpellRequest,
} from "./protocol";
import { normalizeForLookup, scriptOf } from "./script";
import type {
  BlockData,
  ContentSelection,
  Decoration,
  DecorationRange,
  Doc,
  DocPoint,
  DocRange,
  Editor,
  EditorStateSnapshot,
  Operation,
  RangeDecoration,
  TextFieldMark,
} from "@tasfer/editor";

/** How a range decoration is painted (mirrors the core's `RangeDecoration.style`). */
export type RangeDecorationStyle = NonNullable<RangeDecoration["style"]>;

/** The checker's view of the worker: plain request/response, no ids or wiring. */
export interface SpellTransport {
  check(
    req: Omit<Extract<SpellRequest, { type: "check" }>, "id" | "type">,
  ): Promise<readonly CheckedBlock[]>;
  suggest(word: string, script: Script, limit: number): Promise<string[]>;
  /**
   * Fires when dictionaries, user words or settings changed and every block
   * must be re-checked; `words` optionally lists words that became accepted
   * so their flags can be dropped before the rescan lands.
   */
  onInvalidate(cb: (words?: readonly string[]) => void): () => void;
}

export interface SpellCheckerOptions {
  editor: Editor;
  doc: Doc;
  docId: string;
  transport: SpellTransport;
  /** Decoration layer name (default `"spell"`). */
  layer?: string;
  /** Block types never checked (default: code, math, image, line). */
  skipBlockTypes?: ReadonlySet<string>;
  /** Mark names whose runs are never tokenised (default: code, link, math). */
  skipMarks?: ReadonlySet<string>;
  color: () => string;
  /** Default: `{ type: "underline", line: "wavy" }`. */
  style?: () => RangeDecorationStyle;
  /**
   * ARIA token projected into the editor's accessibility tree for each flag
   * (`aria-invalid`). Defaults to `"spelling"`; return `undefined` to opt out.
   */
  a11y?: () => RangeDecoration["a11y"];
  /** Grace after the last keystroke before the caret word may be flagged (500). */
  caretGraceMs?: number;
  /** Debounce per trigger (120 / 250 / 300). */
  debounceMs?: { caret: number; local: number; remote: number };
  maxFlagsPerBlock?: number;
  maxFlags?: number;
  isEnabled: () => boolean;
  ignoredInDocument: () => ReadonlySet<string>;
  flagAllCaps: () => boolean;
  lenientArabic: () => boolean;
  /** Frame scheduler for publishing; defaults to rAF, else `setTimeout(0)`. */
  schedule?: (cb: () => void) => void;
  now?: () => number;
}

/**
 * A flag plus where it lives: its block, the prose field inside the block's
 * structured content when it is not the block's own text (a table cell), the
 * block version it was checked at, and its stable anchors.
 */
export interface FlagRef extends Flag {
  readonly blockId: string;
  readonly field?: TextFieldAddress;
  readonly version: number;
  readonly range: DecorationRange;
}

const DEFAULT_SKIP_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "code",
  "math",
  "image",
  "line",
]);
const DEFAULT_SKIP_MARKS: ReadonlySet<string> = new Set([
  "code",
  "link",
  "math",
]);
const DEFAULT_DEBOUNCE = { caret: 120, local: 250, remote: 300 } as const;
const INITIAL_CHUNK = 20;
const INITIAL_PUBLISH_INTERVAL_MS = 250;
const PREFETCH_DELAY_MS = 100;
const SUGGEST_CACHE_SIZE = 500;
const DEFAULT_SUGGEST_LIMIT = 5;
/** Typing one of these after a word means the word is finished. */
const BOUNDARY_CHAR = /[\s\p{P}]$/u;
/** Any letter, mark or digit: a gap containing one is not "just after" a word. */
const WORDLIKE_RE = /[\p{L}\p{M}\p{N}]/u;

interface CaretPos {
  readonly block: string;
  /** Set when the caret is in a prose field of the block's structured content. */
  readonly field?: TextFieldAddress;
  readonly offset: number;
}

/**
 * Key of one checked text: a block's own text is keyed by the block id, a
 * prose field by the block id and the field's address. NUL never appears in
 * an id, so keys cannot collide.
 */
function unitKey(blockId: string, field?: TextFieldAddress): string {
  return field
    ? `${blockId}\u0000${field.contentId}\u0000${field.nodeId}\u0000${field.field}`
    : blockId;
}

function parseUnitKey(key: string): {
  blockId: string;
  field?: TextFieldAddress;
} {
  const [blockId, contentId, nodeId, field] = key.split("\u0000");
  return contentId === undefined
    ? { blockId }
    : { blockId, field: { contentId, nodeId, field } };
}

function blockOfUnit(key: string): string {
  const at = key.indexOf("\u0000");
  return at < 0 ? key : key.slice(0, at);
}

function sameField(a?: TextFieldAddress, b?: TextFieldAddress): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.contentId === b.contentId && a.nodeId === b.nodeId && a.field === b.field
  );
}

interface Dirty {
  priority: CheckPriority;
  due: number;
}

const PRIORITY_RANK: Record<CheckPriority, number> = {
  caret: 3,
  local: 2,
  remote: 1,
  initial: 0,
};

function defaultSchedule(cb: () => void): void {
  const raf = (
    globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }
  ).requestAnimationFrame;
  if (typeof raf === "function") raf(cb);
  else setTimeout(cb, 0);
}

/**
 * The same lookup key the worker derives from a token, so "Add to dictionary",
 * per-document ignores and flag matching agree with the engine on what a word
 * is (NFC, no bidi controls, Arabic without tashkeel/tatweel).
 */
function normalizeWord(word: string): string {
  return normalizeForLookup(word, scriptOf(word));
}

function pointOf(range: DocRange | null): CaretPos | null {
  if (!range || typeof range === "string") return null;
  if ("from" in range) return pointOf(range.from);
  if ("side" in range) return null;
  return { block: range.block, offset: range.offset ?? 0 };
}

export class SpellChecker {
  private readonly o: SpellCheckerOptions;
  private readonly layer: string;
  private readonly skipBlockTypes: ReadonlySet<string>;
  private readonly skipMarks: ReadonlySet<string>;
  private readonly debounce: { caret: number; local: number; remote: number };
  private readonly caretGraceMs: number;
  private readonly maxFlagsPerBlock: number;
  private readonly maxFlags: number;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void) => void;

  private running = false;
  private disposed = false;
  private unsubscribers: Array<() => void> = [];

  /** Per-block version stamp; bumped on every op touching the block. */
  private versions = new Map<string, number>();
  /** Latest accepted flags per checked text (see {@link unitKey}), sorted by `from`. */
  private flagsByUnit = new Map<string, FlagRef[]>();
  /** Blocks awaiting a check, with the most urgent priority requested. */
  private dirty = new Map<string, Dirty>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private lastLocalInputAt = -Infinity;
  /** Set by a local change; consumed by the next state notification. */
  private changeSinceNotify = false;
  /** Whether the caret reached its current word by typing (vs. a move). */
  private caretByTyping = false;
  private lastCaret: CaretPos | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;

  private publishQueued = false;
  private publishThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPublishAt = -Infinity;
  private initialPassActive = 0;
  private initialPassToken = 0;
  private lastPublishedCount = 0;

  private ignoredOnce = new Set<string>();
  private suggestCache = new Map<string, string[]>();
  private suggestInflight = new Map<string, Promise<string[]>>();
  private flagListeners = new Set<(count: number) => void>();

  constructor(o: SpellCheckerOptions) {
    this.o = o;
    this.layer = o.layer ?? "spell";
    this.skipBlockTypes = o.skipBlockTypes ?? DEFAULT_SKIP_BLOCK_TYPES;
    this.skipMarks = o.skipMarks ?? DEFAULT_SKIP_MARKS;
    this.debounce = o.debounceMs ?? DEFAULT_DEBOUNCE;
    this.caretGraceMs = o.caretGraceMs ?? 500;
    this.maxFlagsPerBlock = o.maxFlagsPerBlock ?? 200;
    this.maxFlags = o.maxFlags ?? 2000;
    this.now = o.now ?? (() => Date.now());
    this.schedule = o.schedule ?? defaultSchedule;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    const { editor, transport } = this.o;
    this.lastCaret = this.caretOf(editor.state);
    this.unsubscribers.push(
      editor.on("change", this.onChange),
      editor.subscribe(this.onSnapshot),
      transport.onInvalidate(this.onInvalidate),
    );
    void this.fullPass();
  }

  /** Stop listening and clear the layer; `start()` resumes with a full pass. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.initialPassToken++;
    this.initialPassActive = 0;
    this.clearTimers();
    this.dirty.clear();
    this.flagsByUnit.clear();
    this.publishQueued = false;
    this.o.editor.view.clearDecorations(this.layer);
    this.setPublishedCount(0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.flagListeners.clear();
    this.suggestCache.clear();
    this.suggestInflight.clear();
    this.ignoredOnce.clear();
  }

  /** Re-check every block (dictionary or setting changed). Flags are replaced as results land. */
  invalidateAll(): void {
    if (!this.running) return;
    this.suggestCache.clear();
    void this.fullPass();
  }

  /** Drop every flag for `word` right now (after "Add to dictionary"). */
  dropWord(word: string): void {
    const key = normalizeWord(word);
    let changed = false;
    for (const [unit, flags] of this.flagsByUnit) {
      const kept = flags.filter((f) => normalizeWord(f.word) !== key);
      if (kept.length !== flags.length) {
        changed = true;
        if (kept.length === 0) this.flagsByUnit.delete(unit);
        else this.flagsByUnit.set(unit, kept);
      }
    }
    if (changed) this.schedulePublish();
  }

  /** Re-check one block immediately (after a replacement). */
  recheck(blockId: string): void {
    if (!this.running) return;
    this.bumpVersion(blockId);
    this.dirty.delete(blockId);
    void this.checkBlocks([blockId], "caret");
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /** The visible flag whose word contains `p` (inclusive at both ends), or `null`. */
  flagAt(p: DocPoint): FlagRef | null {
    const pos = this.resolvePoint(p);
    return pos ? this.flagAtPos(pos) : null;
  }

  /** Every visible flag in document order. */
  flags(): FlagRef[] {
    return this.orderedFlags().map((e) => e.flag);
  }

  count(): number {
    return this.lastPublishedCount;
  }

  next(from: DocPoint, wrap = false): FlagRef | null {
    const pos = this.resolvePoint(from);
    const all = this.orderedFlags();
    if (!pos || all.length === 0) return null;
    const order = this.blockOrder();
    const bi = order.get(pos.block) ?? -1;
    const fi = this.fieldIndex(pos.block, pos.field);
    const hit = all.find(
      (e) =>
        e.blockIndex > bi ||
        (e.blockIndex === bi &&
          (e.fieldIndex > fi || (e.fieldIndex === fi && e.from > pos.offset))),
    );
    return hit?.flag ?? (wrap ? all[0].flag : null);
  }

  /**
   * The flag that ends just before `from` with only spaces or punctuation in
   * between (the word just typed), or `null`. A flag containing `from` counts.
   */
  flagBehind(from: DocPoint): FlagRef | null {
    const pos = this.resolvePoint(from);
    if (!pos) return null;
    const text = this.unitText(pos.block, pos.field);
    if (text === null) return null;
    let best: { flag: FlagRef; to: number } | null = null;
    for (const e of this.liveFlags(unitKey(pos.block, pos.field))) {
      if (e.from > pos.offset) continue;
      if (e.to >= pos.offset) return e.flag;
      if (!best || e.to > best.to) best = e;
    }
    if (!best) return null;
    return WORDLIKE_RE.test(text.slice(best.to, pos.offset)) ? null : best.flag;
  }

  prev(from: DocPoint, wrap = false): FlagRef | null {
    const pos = this.resolvePoint(from);
    const all = this.orderedFlags();
    if (!pos || all.length === 0) return null;
    const order = this.blockOrder();
    const bi = order.get(pos.block) ?? Infinity;
    const fi = this.fieldIndex(pos.block, pos.field);
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i];
      if (
        e.blockIndex < bi ||
        (e.blockIndex === bi &&
          (e.fieldIndex < fi || (e.fieldIndex === fi && e.to < pos.offset)))
      ) {
        return e.flag;
      }
    }
    return wrap ? all[all.length - 1].flag : null;
  }

  /**
   * The flag's current visible span, re-resolved from its anchors, or `null`
   * when the word has since been edited away.
   */
  currentRange(f: FlagRef): { from: number; to: number } | null {
    const raw = findRawBlock(this.o.doc.getRawBlocks(), f.blockId);
    if (!raw) return null;
    return resolveAnchoredRange(charOffsetIndex(raw, f.field), f.range);
  }

  /** Suggestions for a flag (LRU-cached, in-flight requests de-duplicated). */
  suggest(f: FlagRef, limit = DEFAULT_SUGGEST_LIMIT): Promise<string[]> {
    const word = normalizeWord(f.word);
    const key = `${f.script}|${limit}|${word}`;
    const cached = this.suggestCache.get(key);
    if (cached) {
      // Refresh recency.
      this.suggestCache.delete(key);
      this.suggestCache.set(key, cached);
      return Promise.resolve(cached);
    }
    const inflight = this.suggestInflight.get(key);
    if (inflight) return inflight;
    const p = this.o.transport
      .suggest(word, f.script, limit)
      .then((list) => {
        if (!this.disposed) {
          this.suggestCache.set(key, list);
          while (this.suggestCache.size > SUGGEST_CACHE_SIZE) {
            const oldest = this.suggestCache.keys().next().value;
            if (oldest === undefined) break;
            this.suggestCache.delete(oldest);
          }
        }
        return list;
      })
      .finally(() => this.suggestInflight.delete(key));
    this.suggestInflight.set(key, p);
    return p;
  }

  /** Hide this occurrence until the word changes. In-memory only. */
  ignoreOnce(f: FlagRef): void {
    this.ignoredOnce.add(ignoreKey(f));
    this.schedulePublish();
  }

  onFlagsChange(cb: (count: number) => void): () => void {
    this.flagListeners.add(cb);
    return () => {
      this.flagListeners.delete(cb);
    };
  }

  // ── triggers ──────────────────────────────────────────────────────────────

  private onChange = (tx: { isRemote: boolean; ops: readonly Operation[] }) => {
    if (!this.running) return;
    const touched = new Set<string>();
    for (const op of tx.ops) {
      touched.add(op.blockId);
      if (op.op === "block_delete") this.forgetBlock(op.blockId);
    }
    for (const id of touched) this.bumpVersion(id);
    if (!this.o.isEnabled()) return;

    if (tx.isRemote) {
      for (const id of touched) this.queue(id, "remote", this.debounce.remote);
      return;
    }

    const now = this.now();
    this.lastLocalInputAt = now;
    this.changeSinceNotify = true;
    const caret = this.caretOf(this.o.editor.state);
    const caretBlock = caret?.block ?? null;

    for (const id of touched) {
      if (id === caretBlock) this.queue(id, "caret", this.debounce.caret);
      else this.queue(id, "local", this.debounce.local);
    }

    const last = tx.ops[tx.ops.length - 1];
    const typed = last ? insertedText(last) : null;
    const finishedWord =
      caretBlock !== null &&
      last !== undefined &&
      typed !== null &&
      last.blockId === caretBlock &&
      BOUNDARY_CHAR.test(typed);

    if (caret) this.dropFlagsAroundCaret(caret, tx.ops, finishedWord);

    // A word just got finished: check it right away rather than after the
    // debounce, so the squiggle (if any) shows as the user moves on.
    if (finishedWord && caretBlock) {
      this.dirty.delete(caretBlock);
      void this.checkBlocks([caretBlock], "caret");
    }
    this.armGraceTimer();
  };

  private onSnapshot = (snapshot: EditorStateSnapshot) => {
    if (!this.running) return;
    const caret = this.caretOf(snapshot);
    const byTyping = this.changeSinceNotify;
    this.changeSinceNotify = false;
    const prev = this.lastCaret;
    const moved =
      (caret === null) !== (prev === null) ||
      (caret !== null &&
        prev !== null &&
        (caret.block !== prev.block ||
          !sameField(caret.field, prev.field) ||
          caret.offset !== prev.offset));
    if (!moved) return;
    this.lastCaret = caret;
    this.caretByTyping = byTyping;

    // Leaving (or entering) a word changes what the caret-word rule hides;
    // republish from cache — no worker round-trip.
    this.schedulePublish();

    if (this.prefetchTimer) {
      clearTimeout(this.prefetchTimer);
      this.prefetchTimer = null;
    }
    if (!byTyping && caret) {
      this.prefetchTimer = setTimeout(() => {
        this.prefetchTimer = null;
        if (!this.running) return;
        const f = this.flagAtPos(caret);
        if (f) void this.suggest(f).catch(() => undefined);
      }, PREFETCH_DELAY_MS);
    }
  };

  private onInvalidate = (words?: readonly string[]) => {
    if (!this.running) return;
    this.suggestCache.clear();
    this.suggestInflight.clear();
    if (words) for (const w of words) this.dropWord(w);
    void this.fullPass();
  };

  // ── scheduling ────────────────────────────────────────────────────────────

  private bumpVersion(blockId: string): void {
    this.versions.set(blockId, (this.versions.get(blockId) ?? 0) + 1);
  }

  private forgetBlock(blockId: string): void {
    this.versions.delete(blockId);
    this.dirty.delete(blockId);
    let changed = false;
    for (const unit of [...this.flagsByUnit.keys()]) {
      if (blockOfUnit(unit) === blockId) {
        this.flagsByUnit.delete(unit);
        changed = true;
      }
    }
    if (changed) this.schedulePublish();
  }

  private queue(blockId: string, priority: CheckPriority, delay: number): void {
    const due = this.now() + delay;
    const existing = this.dirty.get(blockId);
    if (existing) {
      // Keep the more urgent priority; a fresh edit always restarts the debounce.
      if (PRIORITY_RANK[existing.priority] > PRIORITY_RANK[priority]) {
        priority = existing.priority;
      }
    }
    this.dirty.set(blockId, { priority, due });
    this.armFlushTimer();
  }

  private armFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    let min = Infinity;
    for (const d of this.dirty.values()) min = Math.min(min, d.due);
    if (min === Infinity) {
      this.flushTimer = null;
      return;
    }
    const wait = Math.max(0, min - this.now());
    this.flushTimer = setTimeout(this.flushDue, wait);
  }

  private flushDue = (): void => {
    this.flushTimer = null;
    if (!this.running) return;
    const now = this.now();
    const groups = new Map<CheckPriority, string[]>();
    for (const [id, d] of this.dirty) {
      if (d.due > now) continue;
      this.dirty.delete(id);
      const list = groups.get(d.priority) ?? [];
      list.push(id);
      groups.set(d.priority, list);
    }
    for (const [priority, ids] of groups) void this.checkBlocks(ids, priority);
    this.armFlushTimer();
  };

  /** Everything, ordered caret block → near the viewport → the rest. */
  private async fullPass(): Promise<void> {
    if (!this.running || !this.o.isEnabled()) return;
    const token = ++this.initialPassToken;
    const { editor } = this.o;
    const all = editor.query
      .blocks({ from: "start", to: "end" })
      .filter((b) => !this.skipBlockTypes.has(b.type));
    const live = new Set(all.map((b) => b.id));
    for (const unit of [...this.flagsByUnit.keys()]) {
      if (!live.has(blockOfUnit(unit))) this.flagsByUnit.delete(unit);
    }

    const caretBlock = this.caretOf(editor.state)?.block ?? null;
    const viewport = editor.view.getViewport();
    const near: BlockData[] = [];
    const rest: BlockData[] = [];
    const first: BlockData[] = [];
    for (const b of all) {
      if (b.id === caretBlock) {
        first.push(b);
        continue;
      }
      const c = editor.view.coordsAtPos({ block: b.id, offset: 0 });
      if (c && c.y >= -viewport.height && c.y <= viewport.height) near.push(b);
      else rest.push(b);
    }
    const ordered = [...first, ...near, ...rest];

    this.initialPassActive++;
    try {
      for (let i = 0; i < ordered.length; i += INITIAL_CHUNK) {
        if (!this.running || token !== this.initialPassToken) return;
        const chunk = ordered.slice(i, i + INITIAL_CHUNK).map((b) => b.id);
        await this.checkBlocks(chunk, "initial");
      }
    } finally {
      this.initialPassActive = Math.max(0, this.initialPassActive - 1);
      if (this.initialPassActive === 0) this.schedulePublish();
    }
  }

  // ── checking ──────────────────────────────────────────────────────────────

  private async checkBlocks(
    ids: readonly string[],
    priority: CheckPriority,
  ): Promise<void> {
    if (!this.running || !this.o.isEnabled()) return;
    const { editor } = this.o;
    const blocks: CheckBlock[] = [];
    for (const id of ids) {
      const b = editor.query.block({ block: id });
      if (!b || this.skipBlockTypes.has(b.type)) {
        this.forgetBlock(id);
        continue;
      }
      const version = this.versions.get(id) ?? 0;
      // Prose a node keeps in structured content (a table's cells) is checked
      // field by field; such a block has no prose of its own to check.
      const fields = editor.query.textFields(id);
      if (fields.length > 0) {
        const live = new Set<string>();
        for (const field of fields) {
          const address = {
            contentId: field.contentId,
            nodeId: field.nodeId,
            field: field.field,
          };
          const unit = unitKey(id, address);
          live.add(unit);
          if (field.text.trim().length === 0) {
            this.setFlags(unit, []);
            continue;
          }
          blocks.push({
            blockId: unit,
            version,
            text: field.text,
            skip: this.skipSpansOf(field.marks),
          });
        }
        // A cell that has gone takes its flags with it.
        for (const unit of [...this.flagsByUnit.keys()]) {
          if (blockOfUnit(unit) === id && !live.has(unit)) {
            this.setFlags(unit, []);
          }
        }
        continue;
      }
      if (b.text.trim().length === 0) {
        this.setFlags(id, []);
        continue;
      }
      blocks.push({
        blockId: id,
        version,
        text: b.text,
        skip: this.skipSpans(id, b.text.length),
      });
    }
    if (blocks.length === 0) return;

    let results: readonly CheckedBlock[];
    try {
      results = await this.o.transport.check({
        docId: this.o.docId,
        blocks,
        options: {
          flagAllCaps: this.o.flagAllCaps(),
          lenientArabic: this.o.lenientArabic(),
          ignored: [...this.o.ignoredInDocument()].map(normalizeWord),
        },
        priority,
      });
    } catch {
      // A failed request leaves the previous flags in place; the next edit
      // re-queues the block.
      return;
    }
    if (!this.running) return;
    for (const r of results) this.applyResult(r);
  }

  private skipSpans(
    blockId: string,
    length: number,
  ): ReadonlyArray<readonly [number, number]> {
    if (length === 0) return [];
    return this.skipSpansOf(
      this.o.editor.query.marks({
        from: { block: blockId, offset: 0 },
        to: { block: blockId, offset: length },
      }),
    );
  }

  private skipSpansOf(
    runs: readonly Pick<TextFieldMark, "name" | "from" | "to">[],
  ): ReadonlyArray<readonly [number, number]> {
    const spans: Array<readonly [number, number]> = [];
    for (const m of runs) {
      if (this.skipMarks.has(m.name) && m.to > m.from)
        spans.push([m.from, m.to]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    return spans;
  }

  private applyResult(r: CheckedBlock): void {
    // `r.blockId` is the unit key the request was sent with.
    const unit = r.blockId;
    const { blockId, field } = parseUnitKey(unit);
    if ((this.versions.get(blockId) ?? 0) !== r.version) return; // stale
    const raw = findRawBlock(this.o.doc.getRawBlocks(), blockId);
    if (!raw) {
      this.forgetBlock(blockId);
      return;
    }
    const flags = [...r.flags]
      .sort((a, b) => a.from - b.from)
      .slice(0, this.maxFlagsPerBlock);
    const ranges = anchorRanges(raw, flags, field);
    const refs: FlagRef[] = flags.map((f, i) => ({
      ...f,
      blockId,
      ...(field ? { field } : {}),
      version: r.version,
      range: ranges[i],
    }));
    // Ignore-once entries survive exactly as long as the same word stands at
    // the same anchors; anything else in this text is forgotten.
    const alive = new Set(refs.map(ignoreKey));
    const prefix = `${unit}|`;
    for (const key of this.ignoredOnce) {
      if (key.startsWith(prefix) && !alive.has(key))
        this.ignoredOnce.delete(key);
    }
    this.setFlags(unit, refs);
  }

  private setFlags(unit: string, flags: FlagRef[]): void {
    if (flags.length === 0) {
      if (!this.flagsByUnit.delete(unit)) return;
    } else {
      this.flagsByUnit.set(unit, flags);
    }
    this.schedulePublish();
  }

  /**
   * Typing into a flagged word: drop its squiggle at once instead of waiting
   * for the re-check. Flags whose anchors died with the edit go too.
   */
  private dropFlagsAroundCaret(
    caret: CaretPos,
    ops: readonly Operation[],
    boundaryTyped: boolean,
  ): void {
    const unit = unitKey(caret.block, caret.field);
    const flags = this.flagsByUnit.get(unit);
    if (!flags) return;
    const textual = ops.some(
      (op) => op.blockId === caret.block && isTextEdit(op),
    );
    if (!textual) return;
    const raw = findRawBlock(this.o.doc.getRawBlocks(), caret.block);
    if (!raw) {
      this.forgetBlock(caret.block);
      return;
    }
    const index = charOffsetIndex(raw, caret.field);
    // A boundary char typed right after a word does not touch the word: only
    // the gap after it is "edited". Anything else clears caret ± 1.
    const lo = boundaryTyped ? caret.offset : caret.offset - 1;
    const hi = boundaryTyped ? caret.offset : caret.offset + 1;
    const kept = flags.filter((f) => {
      const live = resolveAnchoredRange(index, f.range);
      if (!live) return false;
      return live.to < lo || live.from > hi;
    });
    if (kept.length !== flags.length) this.setFlags(unit, kept);
  }

  // ── publishing ────────────────────────────────────────────────────────────

  private schedulePublish(): void {
    if (!this.running || this.publishQueued) return;
    this.publishQueued = true;
    this.schedule(() => {
      if (!this.publishQueued) return;
      if (this.initialPassActive > 0) {
        const wait =
          INITIAL_PUBLISH_INTERVAL_MS - (this.now() - this.lastPublishAt);
        if (wait > 0) {
          if (!this.publishThrottleTimer) {
            this.publishThrottleTimer = setTimeout(() => {
              this.publishThrottleTimer = null;
              this.publishQueued = false;
              this.publish();
            }, wait);
          }
          return;
        }
      }
      this.publishQueued = false;
      this.publish();
    });
  }

  private publish(): void {
    if (!this.running) return;
    this.lastPublishAt = this.now();
    const { editor } = this.o;
    const caret = this.caretOf(editor.state);
    const caretUnit = caret ? unitKey(caret.block, caret.field) : null;
    const hideCaretWord =
      caret !== null &&
      this.caretByTyping &&
      this.now() - this.lastLocalInputAt < this.caretGraceMs;

    let entries: FlagRef[] = [];
    for (const [unit, flags] of this.flagsByUnit) {
      let list = flags;
      if (this.ignoredOnce.size > 0) {
        list = list.filter((f) => !this.ignoredOnce.has(ignoreKey(f)));
      }
      if (hideCaretWord && caret && unit === caretUnit) {
        const raw = findRawBlock(this.o.doc.getRawBlocks(), caret.block);
        const index = raw ? charOffsetIndex(raw, caret.field) : null;
        list = list.filter((f) => {
          if (!index) return true;
          const live = resolveAnchoredRange(index, f.range);
          if (!live) return false;
          return !(live.from <= caret.offset && caret.offset <= live.to);
        });
      }
      for (const f of list) entries.push(f);
    }

    if (entries.length > this.maxFlags) {
      const order = this.blockOrder();
      const caretIndex = caret ? (order.get(caret.block) ?? 0) : 0;
      entries = entries
        .map((f, i) => ({
          f,
          i,
          d: Math.abs((order.get(f.blockId) ?? Infinity) - caretIndex),
        }))
        .sort((a, b) => a.d - b.d || a.i - b.i)
        .slice(0, this.maxFlags)
        .map((e) => e.f);
    }

    const color = this.o.color();
    const style = this.o.style?.() ?? { type: "underline", line: "wavy" };
    const a11y = this.o.a11y ? this.o.a11y() : { invalid: "spelling" as const };
    const decorations: Decoration[] = entries.map((f) => ({
      kind: "range",
      range: f.range,
      color,
      opacity: 1,
      style,
      ...(a11y ? { a11y } : {}),
    }));
    editor.view.setDecorations(this.layer, decorations);
    this.setPublishedCount(decorations.length);
    if (hideCaretWord) this.armGraceTimer();
  }

  /** Reveal the caret word once the user pauses. */
  private armGraceTimer(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    const wait = Math.max(
      0,
      this.lastLocalInputAt + this.caretGraceMs - this.now(),
    );
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.schedulePublish();
    }, wait);
  }

  private setPublishedCount(count: number): void {
    if (count === this.lastPublishedCount) return;
    this.lastPublishedCount = count;
    for (const cb of this.flagListeners) cb(count);
  }

  private clearTimers(): void {
    for (const t of [
      this.flushTimer,
      this.graceTimer,
      this.prefetchTimer,
      this.publishThrottleTimer,
    ]) {
      if (t) clearTimeout(t);
    }
    this.flushTimer = null;
    this.graceTimer = null;
    this.prefetchTimer = null;
    this.publishThrottleTimer = null;
  }

  // ── resolution helpers ────────────────────────────────────────────────────

  /**
   * The caret: a flat one from the selection range, or one inside a prose
   * field of structured content (a table cell) from the content selection.
   */
  private caretOf(state: {
    readonly selection: EditorStateSnapshot["selection"];
    readonly contentSelection: ContentSelection | null;
  }): CaretPos | null {
    const flat = pointOf(state.selection.range);
    if (flat) return flat;
    const focus = state.contentSelection?.focus;
    if (!focus || focus.kind !== "text") return null;
    const field = {
      contentId: focus.contentId,
      nodeId: focus.nodeId,
      field: focus.field,
    };
    let offset = 0;
    if (focus.afterCharId !== null) {
      const raw = findRawBlock(this.o.doc.getRawBlocks(), focus.blockId);
      const at = raw
        ? charOffsetIndex(raw, field).get(focus.afterCharId)
        : undefined;
      if (at === undefined) return null;
      offset = at;
    }
    return { block: focus.blockId, field, offset };
  }

  /** The visible flag whose word contains the caret position, or `null`. */
  private flagAtPos(pos: CaretPos): FlagRef | null {
    for (const { flag, from, to } of this.liveFlags(
      unitKey(pos.block, pos.field),
    )) {
      if (from <= pos.offset && pos.offset <= to) return flag;
    }
    return null;
  }

  /** Where a field sits in its block's reading order; `-1` for block text. */
  private fieldIndex(blockId: string, field?: TextFieldAddress): number {
    if (!field) return -1;
    return this.o.editor.query
      .textFields(blockId)
      .findIndex((candidate) => sameField(candidate, field));
  }

  /** The plain text of a block, or of one prose field inside it. */
  private unitText(blockId: string, field?: TextFieldAddress): string | null {
    const { query } = this.o.editor;
    if (field) {
      return (
        query.textFields(blockId).find((f) => sameField(f, field))?.text ?? null
      );
    }
    return query.block({ block: blockId })?.text ?? null;
  }

  private resolvePoint(p: DocPoint): CaretPos | null {
    const { editor } = this.o;
    if (p === "caret") return this.caretOf(editor.state);
    if (p === "start" || p === "end") {
      const blocks = editor.query.blocks({ from: "start", to: "end" });
      const b = p === "start" ? blocks[0] : blocks[blocks.length - 1];
      return b
        ? { block: b.id, offset: p === "start" ? 0 : b.text.length }
        : null;
    }
    if ("side" in p) {
      if (p.side === "before") return { block: p.block, offset: 0 };
      const b = editor.query.block({ block: p.block });
      return b ? { block: p.block, offset: b.text.length } : null;
    }
    return { block: p.block, offset: p.offset ?? 0 };
  }

  private blockOrder(): Map<string, number> {
    const order = new Map<string, number>();
    this.o.editor.query
      .blocks({ from: "start", to: "end" })
      .forEach((b, i) => order.set(b.id, i));
    return order;
  }

  /** One text's visible flags with their current offsets (dead anchors dropped). */
  private liveFlags(
    unit: string,
  ): Array<{ flag: FlagRef; from: number; to: number }> {
    const flags = this.flagsByUnit.get(unit);
    if (!flags) return [];
    const { blockId, field } = parseUnitKey(unit);
    const raw = findRawBlock(this.o.doc.getRawBlocks(), blockId);
    if (!raw) return [];
    const index = charOffsetIndex(raw, field);
    const out: Array<{ flag: FlagRef; from: number; to: number }> = [];
    for (const flag of flags) {
      if (this.ignoredOnce.has(ignoreKey(flag))) continue;
      const live = resolveAnchoredRange(index, flag.range);
      if (live) out.push({ flag, from: live.from, to: live.to });
    }
    return out;
  }

  private orderedFlags(): Array<{
    flag: FlagRef;
    blockIndex: number;
    fieldIndex: number;
    from: number;
    to: number;
  }> {
    const order = this.blockOrder();
    const out: Array<{
      flag: FlagRef;
      blockIndex: number;
      fieldIndex: number;
      from: number;
      to: number;
    }> = [];
    const fieldOrder = new Map<string, number>();
    for (const unit of this.flagsByUnit.keys()) {
      const { blockId, field } = parseUnitKey(unit);
      const blockIndex = order.get(blockId);
      if (blockIndex === undefined) continue;
      let fieldIndex = -1;
      if (field) {
        if (!fieldOrder.has(blockId)) {
          this.o.editor.query.textFields(blockId).forEach((f, i) => {
            fieldOrder.set(unitKey(blockId, f), i);
          });
          fieldOrder.set(blockId, -1);
        }
        fieldIndex = fieldOrder.get(unit) ?? -1;
        if (fieldIndex < 0) continue;
      }
      for (const e of this.liveFlags(unit)) {
        out.push({ ...e, blockIndex, fieldIndex });
      }
    }
    out.sort(
      (a, b) =>
        a.blockIndex - b.blockIndex ||
        a.fieldIndex - b.fieldIndex ||
        a.from - b.from,
    );
    return out;
  }
}

function ignoreKey(f: FlagRef): string {
  const from = "afterCharId" in f.range.from ? f.range.from.afterCharId : "";
  const to = "afterCharId" in f.range.to ? f.range.to.afterCharId : "";
  return `${unitKey(f.blockId, f.field)}|${from}|${to}|${normalizeWord(f.word)}`;
}

/** An edit to characters: in a block's own text or in a structured field. */
function isTextEdit(op: Operation): boolean {
  if (op.op === "text_insert" || op.op === "text_delete") return true;
  return (
    op.op === "content_edit" &&
    (op.edit.kind === "text_insert" || op.edit.kind === "text_delete")
  );
}

/** The text an insert op typed, or `null` for any other op. */
function insertedText(op: Operation): string | null {
  const runs =
    op.op === "text_insert"
      ? op.charRuns
      : op.op === "content_edit" && op.edit.kind === "text_insert"
        ? op.edit.charRuns
        : null;
  if (!runs) return null;
  let text = "";
  for (const run of runs) text += run.text;
  return text;
}
