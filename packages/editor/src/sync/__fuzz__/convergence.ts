import {
  type Block,
  type Page,
  type TextFormat,
} from "../../serlization/loadPage";
import { isTextualBlock } from "../block-registry";
import { getVisibleLengthFromRuns } from "../char-runs";
import type { BlockType, Operation } from "../crdt-types";
import { rebuildState } from "../reducer";
import { SyncEngine } from "../sync";

type TextualType = "paragraph" | "heading1" | "bullet_list" | "todo_list";
const TEXTUAL_TYPES: TextualType[] = [
  "paragraph",
  "heading1",
  "bullet_list",
  "todo_list",
];
const FORMAT_TYPES: TextFormat["type"][] = [
  "bold",
  "italic",
  "strikethrough",
  "code",
];
const ASCII =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?";

type OpKind =
  | "text_insert"
  | "text_delete"
  | "format_set"
  | "block_insert"
  | "block_delete"
  | "block_set";

const OP_WEIGHTS: Array<[OpKind, number]> = [
  ["text_insert", 0.35],
  ["text_delete", 0.2],
  ["format_set", 0.15],
  ["block_insert", 0.15],
  ["block_delete", 0.05],
  ["block_set", 0.1],
];

interface PendingOp {
  originPeerId: string;
  op: Operation;
  deliveredTo: Set<string>;
}

interface Args {
  peers: number;
  ops: number;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    peers: 3,
    ops: 200,
    seed: Math.floor(Math.random() * 1e9),
  };
  for (const raw of argv) {
    const m = /^--([a-z]+)=(.+)$/.exec(raw);
    if (!m) continue;
    const [, key, val] = m;
    if (key === "peers") args.peers = parseInt(val, 10);
    else if (key === "ops") args.ops = parseInt(val, 10);
    else if (key === "seed") args.seed = parseInt(val, 10);
  }
  if (!Number.isFinite(args.peers) || args.peers < 1)
    throw new Error("--peers must be a positive integer");
  if (!Number.isFinite(args.ops) || args.ops < 0)
    throw new Error("--ops must be a non-negative integer");
  if (!Number.isFinite(args.seed))
    throw new Error("--seed must be a finite integer");
  return args;
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
    case "format_set": {
      const block = pickTextualBlock(state, rng, true);
      if (!block) return null;
      const len = visibleLen(block);
      const start = rng.intRange(0, len - 1);
      const end = rng.intRange(start + 1, len);
      const fmtType = rng.pick(FORMAT_TYPES);
      const value = rng.bool();
      return engine.formatText(block.id, start, end, { type: fmtType }, value);
    }
    case "block_insert": {
      const blockType: BlockType = rng.pick(TEXTUAL_TYPES);
      const after =
        state.blocks.length === 0 || rng.next() < 0.2
          ? null
          : (pickAnyBlock(state, rng)?.id ?? null);
      return engine.createBlockInsert(after, blockType);
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
        block.type === "heading3"
      ) {
        const newType = rng.pick([
          "paragraph",
          "heading1",
          "heading2",
          "heading3",
        ] as const);
        return engine.createBlockSet(block.id, "type", newType);
      }
      return null;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`seed=${args.seed} peers=${args.peers} ops=${args.ops}`);
  const start = Date.now();
  const rng = new Random(mulberry32(args.seed));

  const pageId = "fuzz-page";
  const engines: SyncEngine[] = [];
  for (let i = 0; i < args.peers; i++) {
    const peerId = ensureMonotonic(String(i));
    engines.push(new SyncEngine(pageId, peerId));
  }

  // Peer 0 creates the initial paragraph block. Everyone else applies it
  // before any random ops are generated, so all peers share an identical
  // starting state.
  const initialOp = engines[0].createBlockInsert(null, "paragraph");
  engines[0].emit([initialOp]);
  for (let i = 1; i < engines.length; i++) {
    engines[i].apply([initialOp]);
  }

  const pending: PendingOp[] = [];
  let opsEmitted = 0;
  let interleavedFlushes = 0;
  let opsPerPeer = new Array(engines.length).fill(0);

  let nextFlush = rng.intRange(1, 5);

  for (let step = 0; step < args.ops; step++) {
    const peerIdx = step % engines.length;
    const engine = engines[peerIdx];
    const op = generateOp(engine, rng);
    if (!op) continue;
    engine.emit([op]);
    opsEmitted++;
    opsPerPeer[peerIdx]++;

    const delivered = new Set<string>();
    delivered.add(engine.getPeerId());
    pending.push({
      originPeerId: engine.getPeerId(),
      op,
      deliveredTo: delivered,
    });

    nextFlush--;
    if (nextFlush <= 0) {
      interleavedFlushes += partialFlush(engines, pending, rng);
      nextFlush = rng.intRange(1, 5);
    }
  }

  fullFlush(engines, pending);

  const elapsed = Date.now() - start;
  const failure = checkConvergence(engines);
  if (failure) {
    console.log(`FAIL: ${failure.reason}`);
    console.log(failure.detail);
    console.log(
      `seed=${args.seed} peers=${engines.length} ops=${opsEmitted} opsPerPeer=${opsPerPeer.join(",")} interleavedFlushes=${interleavedFlushes} time=${elapsed}ms`,
    );
    process.exit(1);
  }

  console.log(
    `PASS: ${engines.length} peers, ${opsEmitted} ops, ${interleavedFlushes} interleaved flushes, ${elapsed} ms`,
  );
  console.log(`opsPerPeer=${opsPerPeer.join(",")}`);
  process.exit(0);
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

function checkConvergence(engines: SyncEngine[]): FailureInfo | null {
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
    const rebuilt = rebuildState(engine.getPageId(), ops);
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

main().catch((err) => {
  console.error("FAIL: harness error");
  console.error(err);
  process.exit(1);
});
