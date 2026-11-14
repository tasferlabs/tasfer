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
  appendLocalOps,
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
   * The edits just applied. For `applyUpdate`, only the ones the doc did not
   * have yet, sorted by their clock. A batch the doc already has fires no
   * update at all.
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

/**
 * Options for {@link createDoc}: the starting content (Markdown, blocks, or
 * bytes saved earlier), the document's identity, and the schema it uses. Every
 * field is optional.
 */
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
   * Edits to apply on top of the starting content. Every op here is applied. So
   * with `blocks`, pass only the edits made after those blocks were saved.
   * Ignored when `bytes` is given.
   *
   * Pass `ops: []` with no other content for a document that sync will fill. It
   * then starts truly empty, without the blank starter paragraph.
   */
  ops?: Operation[];
  /**
   * Use this when you create a doc from saved `blocks` and call `load()` with
   * the saved edits later. Give the highest clock value and the highest edit id
   * counter in that saved history. Blocks do not record either.
   *
   * Without it, an edit made before `load()` can reuse an old id. Other devices
   * then drop that edit as one they already have, and it can sort before edits
   * it came after. Ignored when `bytes` is given, since bytes carry both.
   */
  frontier?: { clock: number; idCounter: number };
  /** Page id stamped on operations. Defaults to the persisted id or "". */
  pageId?: string;
  /** Stable peer identity. A random one is generated when omitted. */
  peerId?: string;
  /**
   * The block and mark types this document is made of. It decides which fields
   * each block may hold. Defaults to the built-in set. For custom block types,
   * pass `schema.data` from your {@link Schema} (or any `DataSchema`). It must
   * match the schema the `markdown` or `blocks` were written with.
   */
  schema?: DataSchema<D>;
}

/**
 * A document on its own, independent of any editor: its content plus the
 * history of changes that lets copies on different devices merge to the same
 * result. Create one with {@link createDoc}, show it in an editor, and connect
 * sync and storage to it.
 */
export interface Doc<D extends SchemaDefinition = BaseSchemaDefinition> {
  /** @internal Phantom carrier preserving the schema type across APIs. */
  readonly __schemaType?: D;
  /** This replica's peer identity (stamped on every local op). */
  readonly peerId: string;
  /** The page id stamped on operations. */
  readonly pageId: string;

  /**
   * Every block as stored, **including deleted ones** (`deleted: true`). This
   * is what gets saved and synced, and every device ends up with the same
   * blocks once synced. The array is the doc's own, so do not change it.
   *
   * To read what the user sees (deleted blocks removed, `.text` filled in), use
   * an attached editor's `query.blocks(range)`.
   */
  getRawBlocks(): Block[];
  /** Markdown projection of the current document. */
  getMarkdown(): string;

  /**
   * Applies edits that came from outside: a sync provider, storage, or another
   * app. Edits the doc already has are skipped, so sending the same batch twice
   * is safe. Then `on("update")` listeners get the new edits and `origin`
   * (default `"remote"`). If nothing is new, no update fires. New local edits
   * are always ordered after the ones applied here.
   */
  applyUpdate(ops: Operation[], origin?: unknown): void;

  /**
   * Adds saved edits that the doc's blocks already contain. Use it after you
   * create a doc from saved `blocks`, to load the saved edit history behind
   * them. The doc then knows those edits, and new edits are ordered after them.
   *
   * It fires no update and does not redraw the editor, because the blocks
   * already show these edits.
   *
   * Only pass edits that are already in the blocks. An edit passed here that is
   * not in them never shows up, and later copies of it from sync are skipped as
   * already known. For edits that arrive from sync, use {@link applyUpdate}.
   */
  // load registers the ops' log/version-vector metadata in bulk
  // (registerAppliedOps) without replaying the reducer or the
  // dependency-reordering rebuild that applyUpdate's mergeOps does, and
  // advances the binding's clock/id counter past them.
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
 * The format version of the bytes `encodeState()` writes and `createDoc(bytes)`
 * reads. `createDoc` throws on any other version.
 */
// Unlike the op log (forward-compatible: unknown ops/blocks/marks are
// preserved), this envelope is the one piece of data a Doc writes locally and
// owns, so it is the one place we reject an unknown version. See "Releasing
// Updates And Compatibility" at /docs/internals/compatibility. Bump only if the
// envelope's shape changes incompatibly.
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
 * Creates a document. Pass bytes you saved with `doc.encodeState()`, or an
 * options object (see {@link CreateDocOptions}). With nothing, you get an empty
 * document with one blank paragraph.
 *
 * ```ts
 * const doc = createDoc({ markdown: "# Notes" });
 * const editor = createEditor({ element, doc });
 * doc.on("update", (update) => sendToPeers(update.ops));
 * onPeerEdits((ops) => doc.applyUpdate(ops));
 * saveFile(doc.encodeState());
 * // later, from a saved document
 * const restored = createDoc(savedBytes);
 * ```
 *
 * @throws {InvariantError} when `bytes` (in either form) use a format this build cannot read, for example one written by a newer app version. Markdown, blocks and ops never throw this.
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
    if (options.frontier) {
      binding.advanceIdCounter(options.frontier.idCounter);
      maxClockCounter = Math.max(maxClockCounter, options.frontier.clock);
      binding.advanceClock({ counter: options.frontier.clock, peerId: "" });
    }

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
      opLog = appendLocalOps(opLog, ops, schema);
      trackLocalClocks(ops);
      page = opLog.state;

      emit({ ops, origin, local: true });
    },
  };
}
