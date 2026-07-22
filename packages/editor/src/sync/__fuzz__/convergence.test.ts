/**
 * Randomized multi-peer convergence fuzz.
 *
 * Spins up N peers sharing one page, generates weighted random ops on each,
 * delivers them in randomized partial flushes (per-origin causal order is
 * preserved, cross-origin order is shuffled — matching the real sync
 * protocol's guarantees), then asserts:
 *   0) all peers ended up with the same op set,
 *   1) all peer states are byte-identical (canonical JSON),
 *   2) each peer's incremental state matches rebuildState() from its oplog.
 *
 * Runs a handful of fixed seeds (deterministic in CI) plus one random seed
 * per run — the seed is printed so any failure is reproducible via
 * FUZZ_SEED. Override the workload with FUZZ_SEED / FUZZ_PEERS / FUZZ_OPS.
 */

import { getBaseDataSchema } from "../../baseDataSchema";
import { mathDataExtension } from "../../math/data";
import { type Block, type Mark, type Page } from "../../serlization/loadPage";
import type { BlockType, Operation } from "../../state-types";
import { isTextualBlock } from "../block-registry";
import { getVisibleLengthFromRuns } from "../char-runs";
import { orderKeyAfter } from "../crdt-utils";
import { generateKeyBetween } from "../fractional-index";
import { rebuildState } from "../reducer";
import type { DataSchema } from "../schema";
import { createCRDTbinding, createSyncEngine, type SyncEngine } from "../sync";
import { describe, expect, it } from "vitest";

type TextualType = "paragraph" | "heading1" | "bullet_list" | "todo_list";
const TEXTUAL_TYPES: TextualType[] = [
  "paragraph",
  "heading1",
  "bullet_list",
  "todo_list",
];
const FORMAT_TYPES: Mark["type"][] = ["strong", "emphasis", "strike", "code"];
// A tiny url pool so differing-url overlaps are common — that's what exercises
// attr-aware LWW in the reducer and inverse grouping via `areMarksEqual`.
const LINK_URLS = ["https://a", "https://b"];
const ASCII =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?";

type OpKind =
  | "text_insert"
  | "text_delete"
  | "mark_set"
  | "block_insert"
  | "block_delete"
  | "block_set"
  | "block_move";

const OP_WEIGHTS: Array<[OpKind, number]> = [
  ["text_insert", 0.35],
  ["text_delete", 0.2],
  ["mark_set", 0.15],
  ["block_insert", 0.15],
  ["block_delete", 0.05],
  ["block_set", 0.1],
  ["block_move", 0.08],
];

interface PendingOp {
  originPeerId: string;
  op: Operation;
  deliveredTo: Set<string>;
}

interface FuzzArgs {
  peers: number;
  ops: number;
  seed: number;
  /** Peer schema; the default (math-free) exercises unregistered-type drops. */
  schema?: DataSchema;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Random {
  private rnd: () => number;
  constructor(rnd: () => number) {
    this.rnd = rnd;
  }
  next(): number {
    return this.rnd();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.rnd() * maxExclusive);
  }
  intRange(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.rnd() * (maxInclusive - minInclusive + 1))
    );
  }
  bool(): boolean {
    return this.rnd() < 0.5;
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(arr.length)];
  }
  weightedKind(): OpKind {
    const r = this.rnd();
    let acc = 0;
    for (const [k, w] of OP_WEIGHTS) {
      acc += w;
      if (r < acc) return k;
    }
    return OP_WEIGHTS[OP_WEIGHTS.length - 1][0];
  }
  string(len: number): string {
    let s = "";
    for (let i = 0; i < len; i++) s += ASCII[this.int(ASCII.length)];
    return s;
  }
  shuffle<T>(arr: T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

function visibleLen(block: Block): number {
  if (!isTextualBlock(block)) return 0;
  return getVisibleLengthFromRuns(block.charRuns);
}

function pickTextualBlock(
  state: Page,
  rng: Random,
  requireChars: boolean,
): Block | null {
  const candidates = state.blocks.filter(
    (b) =>
      !b.deleted && isTextualBlock(b) && (!requireChars || visibleLen(b) > 0),
  );
  if (candidates.length === 0) return null;
  return rng.pick(candidates);
}

function pickAnyBlock(state: Page, rng: Random): Block | null {
  if (state.blocks.length === 0) return null;
  return rng.pick(state.blocks);
}

function pickLiveBlock(state: Page, rng: Random): Block | null {
  const candidates = state.blocks.filter((b) => !b.deleted);
  if (candidates.length === 0) return null;
  return rng.pick(candidates);
}

function generateOp(engine: SyncEngine, rng: Random): Operation | null {
  const state = engine.getState();
  let attempts = 0;
  while (attempts++ < 6) {
    const kind = rng.weightedKind();
    const op = tryGenerateOp(engine, state, kind, rng);
    if (op) return op;
  }
  return tryGenerateOp(engine, state, "block_insert", rng);
}

function tryGenerateOp(
  engine: SyncEngine,
  state: Page,
  kind: OpKind,
  rng: Random,
): Operation | null {
  switch (kind) {
    case "text_insert": {
      const block = pickTextualBlock(state, rng, false);
      if (!block) return null;
      const len = visibleLen(block);
      const pos = rng.intRange(0, len);
      const text = rng.string(rng.intRange(1, 20));
      return engine.insertText(block.id, pos, text);
    }
    case "text_delete": {
      const block = pickTextualBlock(state, rng, true);
      if (!block) return null;
      const len = visibleLen(block);
      const start = rng.intRange(0, len - 1);
      const end = rng.intRange(start + 1, len);
      return engine.deleteText(block.id, start, end);
    }
    case "mark_set": {
      const block = pickTextualBlock(state, rng, true);
      if (!block) return null;
      const len = visibleLen(block);
      const start = rng.intRange(0, len - 1);
      const end = rng.intRange(start + 1, len);
      const value = rng.bool();
      // Mostly flag-style marks; sometimes an attributed mark (a link carrying
      // a url) so the fuzz exercises attr convergence + inverse grouping.
      const mark: Mark =
        rng.next() < 0.25
          ? { type: "link", attrs: { url: rng.pick(LINK_URLS) } }
          : { type: rng.pick(FORMAT_TYPES) };
      return engine.formatText(block.id, start, end, mark, value);
    }
    case "block_insert": {
      const blockType: BlockType = rng.pick(TEXTUAL_TYPES);
      const after =
        state.blocks.length === 0 || rng.next() < 0.2
          ? null
          : (pickAnyBlock(state, rng)?.id ?? null);
      return engine.createBlockInsert(
        orderKeyAfter(state.blocks, after),
        blockType,
      );
    }
    case "block_delete": {
      const block = pickLiveBlock(state, rng);
      if (!block) return null;
      return engine.createBlockDelete(block.id);
    }
    case "block_set": {
      const block = pickLiveBlock(state, rng);
      if (!block) return null;
      if (
        block.type === "bullet_list" ||
        block.type === "numbered_list" ||
        block.type === "todo_list"
      ) {
        if (rng.bool() && block.type === "todo_list") {
          return engine.createBlockSet(block.id, "checked", rng.bool());
        }
        const indent = rng.intRange(0, 4);
        return engine.createBlockSet(block.id, "indent", indent);
      }
      if (
        block.type === "paragraph" ||
        block.type === "heading1" ||
        block.type === "heading2" ||
        block.type === "heading3" ||
        (block.type as string) === "math"
      ) {
        const newType = rng.pick([
          "paragraph",
          "heading1",
          "heading2",
          "heading3",
          "math",
        ] as const);
        return engine.createBlockSet(block.id, "type", newType);
      }
      return null;
    }
    case "block_move": {
      const block = pickLiveBlock(state, rng);
      if (!block) return null;
      // Move to the head sometimes; otherwise after any block (possibly a
      // tombstone, which the reducer handles). Two peers picking each other's
      // block exercises the cycle path.
      const target =
        rng.next() < 0.2 ? null : (pickAnyBlock(state, rng)?.id ?? null);
      if (target === block.id) return null;
      // A move is an LWW write of the block's orderKey.
      return engine.createBlockSet(
        block.id,
        "orderKey",
        orderKeyAfter(state.blocks, target),
      );
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Map) {
    const entries = Array.from(value.entries()).map(
      ([k, v]) => [k, canonicalize(v)] as const,
    );
    entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return { __map__: entries };
  }
  if (value instanceof Set) {
    return { __set__: Array.from(value).map(canonicalize).sort() };
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const k of keys) result[k] = canonicalize(obj[k]);
  return result;
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function describeDiff(a: Page, b: Page, peerA: string, peerB: string): string {
  const lines: string[] = [];
  lines.push(`Divergence between peer ${peerA} and peer ${peerB}:`);
  lines.push(`  blocks.length: ${a.blocks.length} vs ${b.blocks.length}`);
  const idsA = a.blocks.map((x) => `${x.id}${x.deleted ? "*" : ""}`);
  const idsB = b.blocks.map((x) => `${x.id}${x.deleted ? "*" : ""}`);
  lines.push(`  block order A: ${idsA.join(", ")}`);
  lines.push(`  block order B: ${idsB.join(", ")}`);
  const max = Math.max(a.blocks.length, b.blocks.length);
  for (let i = 0; i < max; i++) {
    const ba = a.blocks[i];
    const bb = b.blocks[i];
    if (!ba || !bb) {
      lines.push(`  [${i}] one side missing`);
      continue;
    }
    if (canonicalJSON(ba) === canonicalJSON(bb)) continue;
    lines.push(`  [${i}] block ${ba.id} vs ${bb.id} differs`);
    if (isTextualBlock(ba) && isTextualBlock(bb)) {
      const ta = ba.charRuns
        .map(
          (r) =>
            `${r.peerId}@${r.startCounter}:"${r.text}"${r.deletedMask ? `(d=${r.deletedMask.join("/")})` : ""}`,
        )
        .join(" | ");
      const tb = bb.charRuns
        .map(
          (r) =>
            `${r.peerId}@${r.startCounter}:"${r.text}"${r.deletedMask ? `(d=${r.deletedMask.join("/")})` : ""}`,
        )
        .join(" | ");
      lines.push(`     runs A: ${ta}`);
      lines.push(`     runs B: ${tb}`);
      const fa = ba.formats
        .map(
          (f) =>
            `${f.format.type}[${f.startCharId}..${f.endCharId}]@${f.clock.counter}-${f.clock.peerId}`,
        )
        .join(" | ");
      const fb = bb.formats
        .map(
          (f) =>
            `${f.format.type}[${f.startCharId}..${f.endCharId}]@${f.clock.counter}-${f.clock.peerId}`,
        )
        .join(" | ");
      if (fa !== fb) {
        lines.push(`     formats A: ${fa}`);
        lines.push(`     formats B: ${fb}`);
      }
    } else {
      lines.push(`     A: ${canonicalJSON(ba)}`);
      lines.push(`     B: ${canonicalJSON(bb)}`);
    }
  }
  return lines.join("\n");
}

function ensureMonotonic(peerId: string): string {
  // Pad with leading zeros so lexicographic comparison matches numerical order.
  return `p${peerId.padStart(3, "0")}`;
}

function counterOf(op: Operation): number {
  const colon = op.id.indexOf(":");
  return colon === -1 ? 0 : parseInt(op.id.slice(colon + 1), 10);
}

function partialFlush(
  engines: SyncEngine[],
  pending: PendingOp[],
  rng: Random,
): number {
  if (pending.length === 0) return 0;

  // Pick a random subset of TARGET peers.
  const targetCount = rng.intRange(1, engines.length);
  const targets = rng.shuffle(engines.slice()).slice(0, targetCount);

  let flushed = 0;
  for (const target of targets) {
    const tid = target.getPeerId();
    const undeliveredHere = pending.filter((p) => !p.deliveredTo.has(tid));
    if (undeliveredHere.length === 0) continue;

    // Group undelivered ops by origin peer and sort each group by counter so
    // that ops from the same origin are delivered in their causal order
    // (matching the real `getOpsSince` semantics). Origin groups themselves
    // are interleaved randomly so different peers see a different mix.
    const byOrigin = new Map<string, PendingOp[]>();
    for (const p of undeliveredHere) {
      const list = byOrigin.get(p.originPeerId) ?? [];
      list.push(p);
      byOrigin.set(p.originPeerId, list);
    }
    for (const list of byOrigin.values()) {
      list.sort((a, b) => counterOf(a.op) - counterOf(b.op));
    }

    // Each origin contributes a random-length prefix of its ordered queue.
    const queues: PendingOp[][] = [];
    for (const list of byOrigin.values()) {
      const prefixLen = rng.intRange(1, list.length);
      queues.push(list.slice(0, prefixLen));
    }

    // Interleave the queues round-robin-ish using random selection. This
    // preserves per-origin order while randomizing cross-origin ordering.
    const merged: PendingOp[] = [];
    while (queues.length > 0) {
      const idx = rng.int(queues.length);
      const q = queues[idx];
      merged.push(q.shift() as PendingOp);
      if (q.length === 0) queues.splice(idx, 1);
    }

    // Apply one-at-a-time to expose intermediate states to the reducer.
    for (const p of merged) {
      target.apply([p.op]);
      p.deliveredTo.add(tid);
      flushed++;
    }
  }
  return flushed;
}

function fullFlush(engines: SyncEngine[], pending: PendingOp[]): void {
  // For each target peer, group remaining undelivered ops by origin and
  // deliver each group in counter order. Apply each group together so
  // mergeOps sees a contiguous batch from each origin peer (the same
  // invariant the real sync protocol relies on).
  for (const target of engines) {
    const tid = target.getPeerId();
    const undelivered = pending.filter((p) => !p.deliveredTo.has(tid));
    if (undelivered.length === 0) continue;

    const byOrigin = new Map<string, PendingOp[]>();
    for (const p of undelivered) {
      const list = byOrigin.get(p.originPeerId) ?? [];
      list.push(p);
      byOrigin.set(p.originPeerId, list);
    }
    for (const list of byOrigin.values()) {
      list.sort((a, b) => counterOf(a.op) - counterOf(b.op));
      const ops = list.map((p) => p.op);
      target.apply(ops);
      for (const p of list) p.deliveredTo.add(tid);
    }
  }
}

interface FailureInfo {
  reason: string;
  detail: string;
}

function checkConvergence(
  engines: SyncEngine[],
  schema?: DataSchema,
): FailureInfo | null {
  // 0) All peers should have received the same set of ops.
  const opCounts = engines.map((e) => e.getOperations().length);
  for (let i = 1; i < opCounts.length; i++) {
    if (opCounts[i] !== opCounts[0]) {
      return {
        reason: `peer ${engines[i].getPeerId()} has ${opCounts[i]} ops, peer ${engines[0].getPeerId()} has ${opCounts[0]}`,
        detail: `Op counts diverged after fullFlush — pending queue bug?`,
      };
    }
  }

  // 1) Cross-peer state equality.
  const states = engines.map((e) => e.getState());
  const stringified = states.map((s) => canonicalJSON(s));
  for (let i = 1; i < stringified.length; i++) {
    if (stringified[0] !== stringified[i]) {
      return {
        reason: `peer ${engines[0].getPeerId()} state differs from peer ${engines[i].getPeerId()}`,
        detail: describeDiff(
          states[0],
          states[i],
          engines[0].getPeerId(),
          engines[i].getPeerId(),
        ),
      };
    }
  }

  // 2) Incremental state must match a full rebuild from the same oplog.
  for (const engine of engines) {
    const incremental = engine.getState();
    const ops = engine.getOperations();
    const rebuilt = rebuildState(engine.getPageId(), ops, schema);
    if (canonicalJSON(incremental) !== canonicalJSON(rebuilt)) {
      return {
        reason: `peer ${engine.getPeerId()} incremental state diverges from rebuildState`,
        detail: describeDiff(
          incremental,
          rebuilt,
          `${engine.getPeerId()}/incremental`,
          `${engine.getPeerId()}/rebuilt`,
        ),
      };
    }
  }

  return null;
}

interface FuzzRun {
  failure: FailureInfo | null;
  /** Block types present in the converged state — vacuity guard for variants. */
  blockTypes: ReadonlySet<string>;
}

function runFuzz(args: FuzzArgs): FuzzRun {
  const rng = new Random(mulberry32(args.seed));

  const pageId = "fuzz-page";
  const engines: SyncEngine[] = [];
  for (let i = 0; i < args.peers; i++) {
    const peerId = ensureMonotonic(String(i));
    engines.push(
      createSyncEngine(createCRDTbinding(pageId, peerId), args.schema),
    );
  }

  // Peer 0 creates the initial paragraph block. Everyone else applies it
  // before any random ops are generated, so all peers share an identical
  // starting state.
  const initialOp = engines[0].createBlockInsert(
    generateKeyBetween(null, null),
    "paragraph",
  );
  engines[0].emit([initialOp]);
  for (let i = 1; i < engines.length; i++) {
    engines[i].apply([initialOp]);
  }

  const pending: PendingOp[] = [];
  let nextFlush = rng.intRange(1, 5);

  for (let step = 0; step < args.ops; step++) {
    const peerIdx = step % engines.length;
    const engine = engines[peerIdx];
    const op = generateOp(engine, rng);
    if (!op) continue;
    engine.emit([op]);

    const delivered = new Set<string>();
    delivered.add(engine.getPeerId());
    pending.push({
      originPeerId: engine.getPeerId(),
      op,
      deliveredTo: delivered,
    });

    nextFlush--;
    if (nextFlush <= 0) {
      partialFlush(engines, pending, rng);
      nextFlush = rng.intRange(1, 5);
    }
  }

  fullFlush(engines, pending);

  return {
    failure: checkConvergence(engines, args.schema),
    blockTypes: new Set(
      engines[0].getState().blocks.map((block) => block.type),
    ),
  };
}

function envInt(name: string, fallback: number): number {
  // Vitest runs in Node, but this browser-lib tsconfig has no Node globals.
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  const raw = env?.[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

describe("multi-peer convergence fuzz", () => {
  const peers = envInt("FUZZ_PEERS", 3);
  const ops = envInt("FUZZ_OPS", 200);

  // Deterministic seeds keep CI stable; failures on the random seed below
  // are reproducible by re-running with FUZZ_SEED=<printed seed>.
  const fixedSeeds = [12345, 67890, 424242];

  for (const seed of fixedSeeds) {
    it(`converges (seed=${seed}, peers=${peers}, ops=${ops})`, () => {
      const { failure } = runFuzz({ peers, ops, seed });
      expect(
        failure,
        failure ? `${failure.reason}\n${failure.detail}` : undefined,
      ).toBeNull();
    });
  }

  it("converges (random or FUZZ_SEED seed)", () => {
    const seed = envInt("FUZZ_SEED", Math.floor(Math.random() * 1e9));
    console.log(`fuzz seed=${seed} (re-run with FUZZ_SEED=${seed})`);
    const { failure } = runFuzz({ peers, ops, seed });
    expect(
      failure,
      failure
        ? `seed=${seed}\n${failure.reason}\n${failure.detail}`
        : undefined,
    ).toBeNull();
  });

  // The default schema DROPS math ops (unregistered type), so the runs above
  // never exercise math replay. This variant installs the spec-carried math
  // data extension on every peer so `math` morphs and their text edits
  // materialize — in the incremental states AND in the rebuild — and must
  // converge. The blockTypes assertion keeps the run non-vacuous: the fixed
  // seeds are chosen so at least one math block survives in the final state.
  it(`converges with the math data extension installed (peers=${peers}, ops=${ops})`, () => {
    const schema = getBaseDataSchema().extend(mathDataExtension());
    let sawMath = false;
    for (const seed of [987654, 24680, 555111]) {
      const { failure, blockTypes } = runFuzz({ peers, ops, seed, schema });
      expect(
        failure,
        failure
          ? `seed=${seed}\n${failure.reason}\n${failure.detail}`
          : undefined,
      ).toBeNull();
      sawMath ||= blockTypes.has("math");
    }
    expect(sawMath, "no seed materialized a math block — vacuous run").toBe(
      true,
    );
  });
});
