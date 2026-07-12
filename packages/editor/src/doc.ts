/**
 * Doc — the CRDT document as a first-class, editor-independent object.
 *
 * A Doc owns everything a replica needs to converge with its peers:
 *   - the operation log + version vector (what we've seen),
 *   - the HLC clock + id generator (how new local ops are stamped),
 *   - the canonical block state (the current document, with tombstones).
 *
 * Editors are views over a Doc: `createEditor({ doc })` attaches one (and
 * creates a private Doc when none is passed, so single-player callers never
 * touch this module). Transports/persistence talk to the Doc only:
 *
 *   const doc = createDoc(savedBytes);
 *   doc.on("update", (u) => send(u.ops));        // outbound
 *   onReceive((ops) => doc.applyUpdate(ops));     // inbound — dedup'd by VV
 *   save(doc.encodeState());                      // lossless persistence
 *
 * Every update carries an `origin` so consumers can ignore their own echoes
 * (an attached editor skips updates it produced; a provider can skip updates
 * it just applied).
 */

import { getBaseDataSchema } from "./baseDataSchema";
import type { BaseSchemaDefinition, SchemaDefinition } from "./schema-types";
import { type Block, loadPage, type Page } from "./serlization/loadPage";
import { serializeToMarkdown } from "./serlization/serializer";
import type {
  CRDTbinding,
  Operation,
  OpLog,
  VersionVector,
} from "./state-types";
import { compareHLC } from "./sync/hlc";
import {
  appendOp,
  createOpLog,
  deserializeVV,
  getOpsSince,
  isOpKnown,
  mergeOps,
  registerAppliedOps,
  serializeVV,
} from "./sync/oplog";
import { cleanSnapshotForSave } from "./sync/reducer";
import type { DataSchema } from "./sync/schema";
import {
  createCRDTbinding,
  maxOpIdCounter,
  maxPageIdCounter,
} from "./sync/sync";
import { invariant } from "@shared/invariant";

/** An applied batch of operations, delivered to `Doc.on("update")` listeners. */
export interface DocUpdate {
  /**
   * The freshly applied operations. For `applyUpdate` batches this contains
   * only the ops that were NOT already known (version-vector filtered), in
   * HLC order — re-delivering a known batch produces no update at all.
   */
  ops: Operation[];
  /**
   * Who caused the update: the editor handle that produced local ops, or
   * whatever value was passed to `applyUpdate` (a provider, "remote", …).
   * Compare against your own identity to ignore echoes.
   */
  origin: unknown;
  /** True when the ops were produced locally by an attached editor. */
  local: boolean;
}

export interface CreateDocOptions<
  D extends SchemaDefinition = BaseSchemaDefinition,
> {
  /** Initial content as Markdown. Ignored when `blocks` or `bytes` is given. */
  markdown?: string;
  /** Initial content as pre-parsed blocks (e.g. a persisted snapshot). */
  blocks?: Block[];
  /**
   * Restore a doc persisted with `encodeState()`. Takes precedence over
   * `markdown`/`blocks`/`ops`. Throws if the blob's format version is
   * unreadable by this build — see `createDoc`.
   */
  bytes?: Uint8Array;
  /**
   * Operations to load into the log. Combine with `blocks` to restore the
   * app-style "snapshot + ops since snapshot" shape — ops already reflected
   * in the snapshot are skipped via their version-vector entries only when
   * restoring from `bytes`; with plain `blocks` pass only the tail ops.
   * Pass `ops: []` (and no content) for a doc that will be filled entirely
   * by sync — it then starts truly empty, without the editable starter
   * paragraph an empty doc otherwise gets.
   */
  ops?: Operation[];
  /** Page id stamped on operations. Defaults to the persisted id or "". */
  pageId?: string;
  /** Stable peer identity. A random one is generated when omitted. */
  peerId?: string;
  /**
   * The block/mark types this document is made of. Controls how the reducer
   * validates fields and materializes block types. Defaults to the built-in
   * set; pass `someSchema.data` (or any `DataSchema`) to support custom block
   * types. Must match the schema the markdown/blocks were authored with.
   */
  schema?: DataSchema<D>;
}

export interface Doc<D extends SchemaDefinition = BaseSchemaDefinition> {
  /** @internal Phantom carrier preserving the schema type across APIs. */
  readonly __schemaType?: D;
  /** This replica's peer identity (stamped on every local op). */
  readonly peerId: string;
  /** The page id stamped on operations. */
  readonly pageId: string;

  /**
   * The raw, fully-merged CRDT block array — **including tombstones**
   * (`deleted: true`) — with no text extraction or type sugar. This is the
   * canonical storage/sync state, stable across peers.
   *
   * For a filtered, presentation-ready read (tombstones removed, `.text`
   * materialized, heading sugar applied, range-addressable), use an attached
   * editor's `query.blocks(range)` instead.
   */
  getRawBlocks(): Block[];
  /** Markdown projection of the current document. */
  getMarkdown(): string;

  /**
   * Apply operations from outside (a provider, persistence, another host).
   * Already-known ops are filtered via the version vector, so re-delivery is
   * a safe no-op. Advances the local clock/id counter past everything
   * applied, updates the document state, and notifies `on("update")`
   * listeners with the fresh ops and the given `origin`.
   */
  applyUpdate(ops: Operation[], origin?: unknown): void;

  /**
   * Register operations that are ALREADY reflected in the doc's current blocks
   * — the async tail of the "snapshot + ops" restore shape: a doc is created
   * from persisted snapshot blocks, then the persisted op log (which produced
   * those blocks) is loaded afterwards so the version vector, op log, and
   * clock/id counter catch up to what the blocks represent.
   *
   * Unlike {@link applyUpdate}, this emits NO update and does not re-render any
   * attached editor (the editor already shows these blocks). The ops are
   * appended to the log, the version vector advances, and the binding's
   * clock/id counter advance past them so subsequent local ops stay causally
   * ahead.
   *
   * Only safe for ops already folded into the seeded blocks. It uses the
   * incremental `appendOp` path, which lacks the dependency-reordering rebuild
   * that {@link applyUpdate}'s `mergeOps` provides — so do NOT route peer ops
   * through `load`; use {@link applyUpdate} for anything arriving from sync.
   */
  load(ops: Operation[]): void;

  /** Subscribe to applied updates (local and remote). Returns unsubscribe. */
  on(event: "update", callback: (update: DocUpdate) => void): () => void;

  /** All operations currently in the log (HLC order). */
  getOperations(): Operation[];
  /** The version vector: highest op counter seen per peer. */
  getVersionVector(): VersionVector;
  /** Operations a peer with the given version vector is missing. */
  getOpsSince(peerVV: VersionVector): Operation[];

  /**
   * Serialize the full document state (blocks + op log + version vector) to
   * bytes. Restore with `createDoc(bytes)`. The format is JSON-based and
   * versioned, but not yet covered by any stability guarantee.
   */
  encodeState(): Uint8Array;

  /** Detach all listeners. The doc holds no other external resources. */
  destroy(): void;

  /**
   * The per-instance id/clock/peer-identity source shared with attached
   * editors and sync engines.
   * @internal — wiring detail for `createEditor`; do not use directly.
   */
  readonly _binding: CRDTbinding;
  /**
   * The live, fully-merged page (the same object backing `getRawBlocks`). An
   * attached editor adopts this via `updatePageFromSync` so it renders the
   * canonically-merged state — not an incremental fold that could drop a
   * dependent op.
   * @internal — wiring detail for `createEditor`; use `getRawBlocks` instead.
   */
  _getPage(): Page;
  /**
   * Ingest ops already stamped by this doc's own binding (an attached
   * editor's local edits): append to the log, update state, notify others.
   * @internal — wiring detail for `createEditor`; use `applyUpdate` instead.
   */
  _ingestLocal(ops: Operation[], origin: unknown): void;
}

/**
 * Format version of the `encodeState()`/`createDoc(bytes)` persisted blob.
 *
 * Unlike the op log (which is forward-compatible — unknown ops/blocks/marks
 * are preserved), this top-level envelope is the one piece of data a Doc
 * *writes locally and owns*, so reading a version it doesn't recognize is the
 * one place we reject rather than tolerate (see the "Releasing Updates And
 * Compatibility" note at /docs/internals/compatibility). Bump only if the
 * envelope's shape changes incompatibly.
 */
export const PERSISTED_DOC_VERSION = 1;

/** Persisted wire shape for encodeState()/createDoc(bytes). */
interface PersistedDocV1 {
  v: 1;
  pageId: string;
  /** Highest HLC counter seen, so a restored replica out-orders history. */
  clock: number;
  vv: Record<string, number>;
  blocks: Block[];
  ops: Operation[];
}

function decodePersisted(bytes: Uint8Array): PersistedDocV1 {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const v =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { v?: unknown }).v
      : undefined;
  invariant(
    v === PERSISTED_DOC_VERSION,
    "createDoc: cannot read persisted document — %s (this build reads v%s)",
    typeof v === "number"
      ? `unsupported format version ${v}`
      : "missing or malformed version field",
    PERSISTED_DOC_VERSION,
  );
  return parsed as PersistedDocV1;
}

/**
 * Create a CRDT document.
 *
 * Accepts persisted bytes directly (`createDoc(savedBytes)`) or an options
 * object — see {@link CreateDocOptions}.
 *
 * @throws {InvariantError} when restoring from `bytes` (either form) and the
 *   blob's format version isn't one this build can read — e.g. it was written
 *   by a newer app version. The non-`bytes` forms (markdown/blocks/ops) never
 *   throw it.
 */
export function createDoc<D extends SchemaDefinition = BaseSchemaDefinition>(
  input?: CreateDocOptions<D> | Uint8Array,
): Doc<D> {
  const options: CreateDocOptions<D> =
    input instanceof Uint8Array ? { bytes: input } : (input ?? {});

  const persisted = options.bytes ? decodePersisted(options.bytes) : null;

  const pageId = options.pageId ?? persisted?.pageId ?? "";
  const binding = createCRDTbinding(pageId, options.peerId);
  const schema = options.schema ?? getBaseDataSchema();

  let opLog: OpLog = createOpLog(pageId);
  // The materialized document. Kept identical to `opLog.state` at all times —
  // the op log's append/merge paths are the single computation of state, so
  // `page` inherits `mergeOps`' slow rebuild path (which recovers, e.g., a
  // text_insert whose anchor arrives in a later batch). A separate incremental
  // fold here would silently drop such ops; don't reintroduce one.
  let page: Page;
  // Highest HLC counter this replica has observed; persisted so a restored
  // doc keeps out-ordering ops that were compacted out of the log.
  let maxClockCounter = 0;

  const listeners = new Set<(update: DocUpdate) => void>();

  const emit = (update: DocUpdate): void => {
    for (const listener of listeners) {
      listener(update);
    }
  };

  /** Advance the binding past foreign ops so local ops stay causally ahead. */
  const advanceBindingPast = (ops: Operation[]): void => {
    for (const op of ops) {
      binding.advanceClock(op.clock);
      if (op.clock.counter > maxClockCounter) {
        maxClockCounter = op.clock.counter;
      }
    }
    binding.advanceIdCounter(maxOpIdCounter(ops));
  };

  const trackLocalClocks = (ops: Operation[]): void => {
    for (const op of ops) {
      if (op.clock.counter > maxClockCounter) {
        maxClockCounter = op.clock.counter;
      }
    }
  };

  // ── Initialization ───────────────────────────────────────────────────────
  // Materialize the starting blocks, then seed them as the op log's state so
  // `page` and `opLog.state` are one object from the outset.
  let initialBlocks: Block[];
  if (persisted) {
    // Blocks already reflect every op in the persisted log — seed them as the
    // base rather than replaying. The version vector is restored verbatim so
    // ops compacted into the blocks stay recognized as known.
    initialBlocks = persisted.blocks;
  } else if (options.blocks || options.markdown !== undefined) {
    initialBlocks =
      options.blocks ?? loadPage(options.markdown ?? "", schema).blocks;
  } else if (options.ops) {
    // Ops-only init: build entirely from the ops — no starter paragraph.
    initialBlocks = [];
  } else {
    // Empty editable doc: same starter block an empty editor gets.
    initialBlocks = loadPage("", schema).blocks;
  }

  page = { id: pageId, title: "", blocks: initialBlocks };
  opLog = {
    pageId,
    operations: persisted ? persisted.ops : [],
    versionVector: persisted ? deserializeVV(persisted.vv) : new Map(),
    state: page,
  };

  if (persisted) {
    binding.advanceIdCounter(
      Math.max(
        maxPageIdCounter(persisted.blocks),
        maxOpIdCounter(persisted.ops),
      ),
    );
    maxClockCounter = persisted.clock;
    binding.advanceClock({ counter: persisted.clock, peerId: "" });
  } else {
    binding.advanceIdCounter(maxPageIdCounter(initialBlocks));

    if (options.ops && options.ops.length > 0) {
      const ops = [...options.ops].sort((a, b) => compareHLC(a.clock, b.clock));
      opLog = mergeOps(opLog, ops, schema);
      page = opLog.state;
      advanceBindingPast(ops);
    }
  }

  return {
    get peerId() {
      return binding.getPeerId();
    },
    pageId,

    getRawBlocks(): Block[] {
      return page.blocks;
    },

    getMarkdown(): string {
      return serializeToMarkdown(page.blocks, undefined, { schema });
    },

    applyUpdate(ops: Operation[], origin: unknown = "remote"): void {
      const fresh = ops.filter((op) => !isOpKnown(opLog.versionVector, op));
      if (fresh.length === 0) return;
      fresh.sort((a, b) => compareHLC(a.clock, b.clock));

      advanceBindingPast(fresh);
      opLog = mergeOps(opLog, fresh, schema);
      page = opLog.state;

      emit({ ops: fresh, origin, local: false });
    },

    load(ops: Operation[]): void {
      if (ops.length === 0) return;
      // The seeded snapshot already contains these operations. Register their
      // log/VV metadata in bulk without replaying the reducer or replacing the
      // snapshot-backed page.
      opLog = registerAppliedOps(opLog, ops);
      advanceBindingPast(ops);
    },

    on(event: "update", callback: (update: DocUpdate) => void): () => void {
      if (event !== "update") return () => {};
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },

    getOperations(): Operation[] {
      return opLog.operations;
    },

    getVersionVector(): VersionVector {
      return opLog.versionVector;
    },

    getOpsSince(peerVV: VersionVector): Operation[] {
      return getOpsSince(opLog, peerVV);
    },

    encodeState(): Uint8Array {
      const payload: PersistedDocV1 = {
        v: 1,
        pageId,
        clock: maxClockCounter,
        vv: serializeVV(opLog.versionVector),
        blocks: cleanSnapshotForSave(page.blocks),
        ops: opLog.operations,
      };
      return new TextEncoder().encode(JSON.stringify(payload));
    },

    destroy(): void {
      listeners.clear();
    },

    _binding: binding,

    _getPage(): Page {
      return page;
    },

    _ingestLocal(ops: Operation[], origin: unknown): void {
      if (ops.length === 0) return;
      for (const op of ops) {
        opLog = appendOp(opLog, op, schema);
      }
      trackLocalClocks(ops);
      page = opLog.state;

      emit({ ops, origin, local: true });
    },
  };
}
