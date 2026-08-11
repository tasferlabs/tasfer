/**
 * Shared Engine
 *
 * Implements the Platform interface using a Driver.
 * All business logic (SQL queries, snapshot encoding, identity management,
 * space CRDT, pairing) lives here — written ONCE, shared across
 * Electron, Capacitor, and Web.
 */

import type {
  Platform,
  PageListItem,
  ArchivedPageItem,
  PageFull,
  PageCreateInput,
  PageUpdateInput,
  PageMoveInput,
  PageSubtreeItem,
  RecreatePageInput,
  PageSearchResult,
  PageCalendarItem,
  PagePathSegment,
  PageSnapshot,
  Identity,
  Peer,
  Asset,
  Space,
  ArchivedSpaceItem,
  SpaceMember,
  SpaceOperation,
  SpaceInvite,
  PairCallbacks,
} from "./types";
import { deriveIdentitySharedSignalingKey } from "./peer-shared-key";
import {
  type DeviceCert,
  isDeviceKeyShaped,
  issueDeviceCert,
  verifyDeviceCert,
} from "./device-cert";
import { invariant } from "@shared/invariant";
import type { Driver, CryptoDriver, DbRow } from "./driver";
import type { HLC } from "@tasfer/editor";
import type { DeviceLinkPayload, ReplicatorHost } from "./sync";
import { nanoid } from "nanoid";
// Deep import the DOM-free block-order module rather than the `/internal`
// barrel — the barrel re-exports rendering/font code that touches `document`,
// which crashes the engine when it runs inside the SharedWorker (Phase 2).
import { sortBlocksByOrder } from "@tasfer/editor/sync/block-order";
// Worker-safe itself (deep imports only) — derives the title columns from
// blocks; the doc's op log is the source of truth for titles.
import { deriveTitles, extractBodyText } from "../lib/pageTitle";
import { appDataSchema } from "../appDataSchema";
import { collectAssetRefs } from "@tasfer/editor";
import { AssetPrefetcher } from "./asset-prefetch";

/** Minimal interface the engine uses to push ops — avoids circular imports */
interface EngineReplicator {
  pushSpaceOps(spaceId: string, ops: SpaceOperation[]): void;
  pushPageOps(
    spaceId: string,
    pageId: string,
    ops: import("@tasfer/editor/state-types").Operation[],
  ): void;
  requestAsset(hash: string): Promise<boolean>;
  onPeerReady(cb: (publicKey: string) => void): () => void;
  addPeer(publicKey: string): Promise<void>;
  removePeer(publicKey: string): Promise<void>;
  refreshSpaces(): Promise<void>;
  startPairing(opts: {
    invite: SpaceInvite;
    role: "initiator" | "acceptor";
    mode?: "space" | "device";
    spaceName?: string;
    localPublicKey: string;
    localName: string;
    privateKey: string;
    callbacks: PairCallbacks;
    issueDeviceLink?: (
      peerPublicKey: string,
    ) => Promise<DeviceLinkPayload | null>;
    applyDeviceLink?: (payload: DeviceLinkPayload) => Promise<void>;
  }): Promise<void>;
  cancelPairing(secret?: string): Promise<void>;
  isPairingActive(secret: string): boolean;
}

// =============================================================================
// Schema & Migrations
// =============================================================================

const SCHEMA_VERSION = 0;

// Dates persist as UTC instants regardless of the zone the UI edited in.
// scheduled_at range queries compare ISO strings lexicographically, which is
// only correct when every stored value shares the UTC "Z" shape.
function toUtcIso(iso: string | null | undefined): string | null {
  return iso ? new Date(iso).toISOString() : null;
}
// Bump whenever the materialized Block projection gains persisted semantics
// that an older snapshot writer could have omitted while still sharing the same
// op-log frontier (v2 adds generic structured-content attachments).
const PAGE_SNAPSHOT_FORMAT = 2;

/**
 * Sentinel `invites.space_id` for a device link, which joins no single space.
 * Not a valid nanoid(10), so it can never collide with a real space, and the
 * column's UNIQUE constraint keeps at most one device link pending.
 */
const DEVICE_LINK_SCOPE = "@device";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS identity (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    public_key       TEXT NOT NULL,
    private_key      TEXT NOT NULL,
    name             TEXT NOT NULL DEFAULT '',
    avatar           TEXT,
    -- The root ("person") keypair. public_key/private_key above name this
    -- DEVICE; the root names the human who owns it and signs a certificate for
    -- every device they link (see ./device-cert). Copied to each linked device
    -- so any of them can enroll the next one — losing the only copy would
    -- otherwise strand the account with no way to add a device, and a linked
    -- device already holds the plaintext this key would protect.
    root_public_key  TEXT,
    root_private_key TEXT
  );

  -- Device certificates known to this replica, projected from device_add ops in
  -- the space logs. Rebuildable cache, never a source of truth: the ops are.
  CREATE TABLE IF NOT EXISTS devices (
    public_key TEXT PRIMARY KEY,
    root_key   TEXT NOT NULL,
    cert       TEXT NOT NULL,
    issued_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_devices_root ON devices(root_key);

  CREATE TABLE IF NOT EXISTS peers (
    public_key TEXT PRIMARY KEY,
    name       TEXT,
    trusted    INTEGER NOT NULL DEFAULT 0,
    last_seen  INTEGER,
    shared_key TEXT
  );

  CREATE TABLE IF NOT EXISTS spaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    archived_at TEXT,
    created_at  TEXT NOT NULL,
    -- A personal space admits only devices certified by this replica's root
    -- identity, and mints no invites. Deliberately one-way: a flag you can turn
    -- off is a setting, not a guarantee, and the whole point is that writing
    -- here cannot later become someone else's to read. Sharing a personal page
    -- means moving it to a shared space, not reclassifying the space.
    personal    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS invites (
    secret     TEXT PRIMARY KEY,
    space_id   TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS space_members (
    space_id    TEXT NOT NULL,
    public_key  TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    avatar      TEXT,
    added_at    TEXT NOT NULL,
    archived_at TEXT,
    PRIMARY KEY (space_id, public_key)
  );

  CREATE TABLE IF NOT EXISTS pages (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT '',
    title_md      TEXT NOT NULL DEFAULT '',
    body_text     TEXT,
    parent_id     TEXT,
    "order"       REAL NOT NULL DEFAULT 0,
    space_id      TEXT,
    task          INTEGER NOT NULL DEFAULT 0,
    color         TEXT,
    scheduled_at  TEXT,
    duration      INTEGER,
    all_day       INTEGER,
    recurrence_id TEXT,
    archived_at   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pages_space ON pages(space_id);

  CREATE TABLE IF NOT EXISTS ops (
    id         INTEGER PRIMARY KEY,
    scope_id   TEXT NOT NULL,
    peer_id    TEXT NOT NULL,
    clock      INTEGER NOT NULL,
    type       TEXT NOT NULL,
    data       BLOB NOT NULL,
    timestamp  INTEGER NOT NULL,
    target_key TEXT,
    UNIQUE(scope_id, peer_id, clock)
  );

  CREATE INDEX IF NOT EXISTS idx_ops_scope ON ops(scope_id);
  CREATE INDEX IF NOT EXISTS idx_ops_target ON ops(scope_id, type, target_key);

`;

// =============================================================================
// Engine
// =============================================================================

export class Engine implements Platform {
  private driver: Driver;
  private replicator: EngineReplicator | null = null;
  private spaceHlcCounters = new Map<string, number>();
  /** LWW winners: key = "spaceId\0entity\0field", value = {counter, peerId} */
  private spaceLwwWinners = new Map<
    string,
    { counter: number; peerId: string }
  >();
  private spaceChangeListeners = new Set<(spaceId: string) => void>();
  private pageDeleteListeners = new Set<(pageId: string) => void>();
  /**
   * Shared bootstrap for the singleton `identity(id=1)` row. The RPC server
   * dispatches calls without awaiting each other, so `identity.get` and
   * `spaces.list` (which calls `identity.get`) run concurrently on first load;
   * a naive check-then-insert lets both pass the empty SELECT and both INSERT
   * `id=1`, and the second violates the primary key. Memoizing the bootstrap
   * promise collapses all concurrent callers in this engine into one insert.
   */
  private identityReady?: Promise<void>;

  constructor(driver: Driver) {
    this.driver = driver;
  }

  /**
   * Raw database access for developer tooling (DevToolbar). Part of the
   * `Platform` surface so it tunnels over RPC when the engine lives in the
   * SharedWorker. Not for app logic — application data uses the typed
   * namespaces below.
   */
  db = {
    query: <T extends DbRow = DbRow>(sql: string, params?: unknown[]) =>
      this.driver.db.query<T>(sql, params),
    mutate: (sql: string, params?: unknown[]) =>
      this.driver.db.mutate(sql, params),
    exec: (sql: string) => this.driver.db.exec(sql),
    getPendingMigrations: () => this.getPendingMigrations(),
    applyMigrations: () => this.applyMigrations(),
  };

  /** Initialize the database schema. Call once at startup. */
  async init(): Promise<void> {
    await this.driver.db.exec(SCHEMA_SQL);
    // Additive column adds are self-healing: SCHEMA_SQL's CREATE TABLE IF NOT
    // EXISTS is a no-op on an existing database, so probe-and-ALTER here —
    // ALWAYS, even in staging (where versioned migrations wait for the
    // DevToolbar), because every query in this file assumes these columns.
    await this.ensureAdditiveColumns();
    // In staging, migrations are applied explicitly via DevToolbar.
    if (import.meta.env.VITE_STAGING !== "true") {
      await this.applyMigrations();
    }
    // Create the identity now, before any RPC is served, so concurrent
    // first-load callers all observe an existing row instead of racing to
    // insert it.
    await this.ensureIdentity();
    await this.loadSpaceHlcCounters();
    // Publish this device's certificate into spaces that predate device
    // identity. Idempotent and cheap after the first run (one indexed lookup
    // per space), so it stays in the boot path rather than a one-shot
    // migration — a space can also arrive later, from a peer.
    await this.backfillDeviceEnrollment();
    // Populate the body-text search index for pages that predate the column.
    // Fire-and-forget: it replays each page's op log, so it runs in the
    // background rather than delaying the first paint; search picks up body
    // matches page-by-page as it completes, and titles work immediately.
    // The asset sweep runs after it (not concurrently) so at most one
    // background pass is replaying op logs at a time.
    void this.backfillBodyText()
      .catch((err) => console.warn("[Engine] body_text backfill failed:", err))
      .then(() => this.sweepAssetRefs())
      .catch((err) => console.warn("[Engine] asset sweep failed:", err));
  }

  // ---------------------------------------------------------------------------
  // Migrations — sequential, forward-only, idempotent
  // Bump SCHEMA_VERSION when adding a new migration.
  // ---------------------------------------------------------------------------

  /** Returns how many migrations are pending (0 means schema is up to date). */
  async getPendingMigrations(): Promise<number> {
    const [{ user_version }] = await this.driver.db.query<{
      user_version: number;
    }>("PRAGMA user_version");
    return Math.max(0, SCHEMA_VERSION - (user_version as number));
  }

  /**
   * Bring an existing database up to date with columns SCHEMA_SQL added after
   * its tables were first created (CREATE TABLE IF NOT EXISTS won't). Safe and
   * idempotent, so init() runs it unconditionally — unlike versioned
   * migrations, which staging defers to the DevToolbar.
   */
  private async ensureAdditiveColumns(): Promise<void> {
    // pages.title_md — the title's rich (markdown) projection, a local cache
    // derived from doc content (see refreshDerivedTitles).
    const cols = await this.driver.db.query<{ name: string }>(
      "PRAGMA table_info(pages)",
    );
    if (!cols.some((c) => c.name === "title_md")) {
      await this.driver.db.exec(
        "ALTER TABLE pages ADD COLUMN title_md TEXT NOT NULL DEFAULT ''",
      );
    }
    // pages.body_text — the page's full-text body projection, a local cache
    // derived from doc content (see refreshDerivedTitlesFromBlocks) backing
    // command-center content search. Nullable so backfillBodyText can tell an
    // un-derived row (NULL) from a genuinely empty page ('').
    if (!cols.some((c) => c.name === "body_text")) {
      await this.driver.db.exec("ALTER TABLE pages ADD COLUMN body_text TEXT");
    }

    // identity.root_public_key / root_private_key — the person-level keypair
    // that certifies device keys (see ./device-cert). Nullable so an install
    // predating device identity can tell "not yet generated" from "generated";
    // ensureIdentity backfills it and self-certifies the existing device.
    const identityCols = await this.driver.db.query<{ name: string }>(
      "PRAGMA table_info(identity)",
    );
    if (!identityCols.some((c) => c.name === "root_public_key")) {
      await this.driver.db.exec(
        "ALTER TABLE identity ADD COLUMN root_public_key TEXT",
      );
    }
    if (!identityCols.some((c) => c.name === "root_private_key")) {
      await this.driver.db.exec(
        "ALTER TABLE identity ADD COLUMN root_private_key TEXT",
      );
    }

    // spaces.personal — existing spaces default to shared, which is what they
    // already are; personal is only ever set at creation.
    const spaceCols = await this.driver.db.query<{ name: string }>(
      "PRAGMA table_info(spaces)",
    );
    if (!spaceCols.some((c) => c.name === "personal")) {
      await this.driver.db.exec(
        "ALTER TABLE spaces ADD COLUMN personal INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  /** Apply all pending migrations. Safe to call multiple times. */
  async applyMigrations(): Promise<void> {
    const [{ user_version }] = await this.driver.db.query<{
      user_version: number;
    }>("PRAGMA user_version");

    if (user_version < SCHEMA_VERSION) {
      await this.driver.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  /** Load max HLC counters and LWW winners from persisted ops so we never regress after restart */
  private async loadSpaceHlcCounters(): Promise<void> {
    const rows = await this.driver.db.query<{
      scope_id: string;
      max_clock: number;
    }>(
      "SELECT scope_id, MAX(clock) as max_clock FROM ops WHERE scope_id LIKE 'space:%' GROUP BY scope_id",
    );
    for (const r of rows) {
      const spaceId = r.scope_id.slice(6); // strip 'space:' prefix
      this.spaceHlcCounters.set(spaceId, r.max_clock);
    }

    // Replay all space ops in HLC order to build the LWW winners map
    const scopes = await this.driver.db.query<{ scope_id: string }>(
      "SELECT DISTINCT scope_id FROM ops WHERE scope_id LIKE 'space:%'",
    );
    for (const s of scopes) {
      const spaceId = s.scope_id.slice(6);
      const ops = await this.getSpaceOps(spaceId);
      for (const op of ops) {
        this.lwwCheckFromOp(op);
      }
    }
  }

  /** Populate LWW map entry from an op (used during startup replay, no return value needed) */
  private lwwCheckFromOp(op: SpaceOperation): void {
    switch (op.op) {
      case "space_set":
        this.lwwCheck(op.spaceId, "space", op.field, op.clock);
        break;
      case "member_add":
        // member_add is idempotent — no competing remove op
        break;
      case "device_add":
        // Additive and permanent: a certificate either verifies or it does
        // not, and nothing competes to overwrite it.
        break;
      case "member_set":
        this.lwwCheck(op.spaceId, `member:${op.publicKey}`, op.field, op.clock);
        break;
      case "page_add":
      case "page_remove":
        this.lwwCheck(op.spaceId, `page:${op.pageId}`, "_alive", op.clock);
        break;
      case "page_set":
        this.lwwCheck(op.spaceId, `page:${op.pageId}`, op.field, op.clock);
        break;
    }
  }

  /** Set the replicator instance for space sync + pairing */
  setReplicator(repl: EngineReplicator): void {
    this.replicator = repl;
    // A peer completing its handshake is the earliest moment queued asset
    // pulls can succeed — retry everything still missing.
    repl.onPeerReady(() => this.assetPrefetcher.retry());
  }

  /**
   * Eagerly pulls referenced-but-missing assets from peers, so images arrive
   * with the ops that reference them instead of on first render. Fed by
   * remote page/space ops and the startup sweep (see sweepAssetRefs).
   */
  private assetPrefetcher = new AssetPrefetcher({
    listLocalAssetHashes: async () => {
      const files = await this.driver.fs.list(`${this.driver.basePath}/assets`);
      return new Set(files.map((f) => f.slice(0, 64)));
    },
    requestAsset: (hash) =>
      this.replicator?.requestAsset(hash) ?? Promise.resolve(false),
  });

  // ---------------------------------------------------------------------------
  // ReplicatorHost implementation
  // ---------------------------------------------------------------------------

  /** Build a ReplicatorHost adapter for this engine */
  asReplicatorHost(): ReplicatorHost {
    return {
      getIdentity: () => this.identity.get(),
      getPrivateKey: () => this.getPrivateKey(),
      getCrypto: (): CryptoDriver => this.driver.crypto,
      getPeerRecords: () => this.peers.list(),
      getSpaceIds: async () => {
        const spaces = await this.spaces.list();
        return spaces.map((s) => s.id);
      },
      getSpaceState: async (spaceId: string) => {
        const rows = await this.driver.db.query<{ archived_at: string | null }>(
          "SELECT archived_at FROM spaces WHERE id = ?",
          [spaceId],
        );
        if (rows.length === 0) return "unknown" as const;
        return rows[0].archived_at === null
          ? ("active" as const)
          : ("archived" as const);
      },
      getPageSpaceState: async (pageId: string) => {
        const rows = await this.driver.db.query<{
          space_id: string;
          archived_at: string | null;
        }>(
          `SELECT p.space_id, s.archived_at FROM pages p
           JOIN spaces s ON s.id = p.space_id
           WHERE p.id = ?`,
          [pageId],
        );
        if (rows.length === 0) return null;
        return {
          spaceId: rows[0].space_id,
          state:
            rows[0].archived_at === null
              ? ("active" as const)
              : ("archived" as const),
        };
      },
      getOwnDeviceKeys: async () => {
        const identity = await this.identity.get();
        if (!identity.rootPublicKey) return [];
        const rows = await this.driver.db.query<{ public_key: string }>(
          "SELECT public_key FROM devices WHERE root_key = ? AND public_key != ?",
          [identity.rootPublicKey, identity.publicKey],
        );
        return rows.map((r) => r.public_key);
      },
      getSpaceMembers: async (spaceId: string) => {
        // Reads the table rather than `spaces.get`: this list decides who we
        // connect to, so a member soft-removed from the space must drop out of
        // it. `spaces.get` deliberately keeps them for display.
        const rows = await this.queryVisibleMembers(spaceId, {
          includeArchived: false,
        });
        return rows.map((r) => ({ publicKey: r.public_key }));
      },
      getSpaceVV: (spaceId: string) => this.getSpaceVV(spaceId),
      getPageVVs: (spaceId: string) => this.getPageVVs(spaceId),
      buildSyncResponse: (spaceId, spaceVV, pageVVs) =>
        this.buildSpaceSyncResponse(spaceId, spaceVV, pageVVs),
      applyRemoteSpaceOps: (spaceId, ops) =>
        this.handleRemoteSpaceOps(spaceId, ops),
      applyRemotePageOps: (pageId, ops) =>
        this.handleRemotePageOps(pageId, ops),
      getAssetData: async (hash: string) => {
        const assetsDir = `${this.driver.basePath}/assets`;
        const files = await this.driver.fs.list(assetsDir);
        const match = files.find((f) => f.startsWith(hash));
        if (!match) return null;
        const data = await this.driver.fs.read(`${assetsDir}/${match}`);
        if (!data) return null;
        const ext = match.includes(".") ? match.split(".").pop()! : "bin";
        return { ext, data };
      },
      storeAssetData: async (hash: string, ext: string, data: Uint8Array) => {
        const path = `${this.driver.basePath}/assets/${assetFileName(hash, ext)}`;
        if (!(await this.driver.fs.exists(path))) {
          await this.driver.fs.write(path, data);
        }
      },
      buildPageSyncResponse: (
        pageId: string,
        remoteVV: Record<string, number>,
      ) => this.buildPageSyncResponse(pageId, remoteVV),
      getPeerSharedKey: async (publicKey: string): Promise<string | null> => {
        const rows = await this.driver.db.query<{
          shared_key: string | null;
        }>("SELECT shared_key FROM peers WHERE public_key = ?", [publicKey]);
        const storedKey = rows[0]?.shared_key;
        if (storedKey) return storedKey;

        // A member learned through the replicated space log was not directly
        // paired with us, so it has no invite-derived key. Both replicas can
        // still derive the same pairwise key from their identity keypairs and
        // form the missing edge of the replica-set mesh.
        if (rows.length === 0) return null;
        if (!/^[a-f0-9]{64}$/i.test(publicKey)) return null;
        const identity = await this.identity.get();
        const privateKey = await this.getPrivateKey();
        return deriveIdentitySharedSignalingKey(
          privateKey,
          identity.publicKey,
          publicKey,
        );
      },
      updatePeerLastSeen: async (publicKey: string): Promise<void> => {
        await this.driver.db.mutate(
          "UPDATE peers SET last_seen = ? WHERE public_key = ?",
          [Date.now(), publicKey],
        );
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  /**
   * Ensure the singleton identity row exists, generating a keypair on first
   * run. Idempotent and race-free: {@link identityReady} memoizes the work so
   * concurrent callers share one bootstrap, and `INSERT OR IGNORE` tolerates a
   * row a separate worker may have written first.
   */
  private ensureIdentity(): Promise<void> {
    return (this.identityReady ??= (async () => {
      const rows = await this.driver.db.query<{ id: number }>(
        "SELECT id FROM identity WHERE id = 1",
      );
      if (rows.length === 0) {
        const { publicKey, privateKey } =
          await this.driver.crypto.generateKeypair();
        await this.driver.db.mutate(
          "INSERT OR IGNORE INTO identity (id, public_key, private_key, name) VALUES (1, ?, ?, '')",
          [publicKey, privateKey],
        );
      }
      await this.ensureRootIdentity();
    })());
  }

  /**
   * Ensure the root ("person") keypair exists and this device holds a
   * certificate under it. Runs for fresh installs and, as a backfill, for
   * every install predating device identity: the existing device key becomes
   * device #1 of a newly minted root.
   *
   * Self-healing rather than a versioned migration, because it must also cover
   * a replica whose root arrived by device-link after its first boot.
   */
  private async ensureRootIdentity(): Promise<void> {
    type IdentityRow = {
      public_key: string;
      root_public_key: string | null;
      root_private_key: string | null;
    };
    const read = async (): Promise<IdentityRow> => {
      const [row] = await this.driver.db.query<IdentityRow>(
        "SELECT public_key, root_public_key, root_private_key FROM identity WHERE id = 1",
      );
      return row;
    };

    let row = await read();
    if (!row.root_public_key || !row.root_private_key) {
      const { publicKey, privateKey } =
        await this.driver.crypto.generateKeypair();
      // Guarded UPDATE, then re-read: a concurrent worker may have generated a
      // root first, and two roots for one person would split the identity.
      await this.driver.db.mutate(
        "UPDATE identity SET root_public_key = ?, root_private_key = ? WHERE id = 1 AND root_public_key IS NULL",
        [publicKey, privateKey],
      );
      row = await read();
    }
    if (!row.root_public_key || !row.root_private_key) return;

    await this.ensureSelfDeviceCert(
      row.public_key,
      row.root_public_key,
      row.root_private_key,
    );
  }

  /**
   * Self-issue this device's certificate and cache it. Issued once and reused
   * verbatim thereafter, so every `device_add` this replica emits carries
   * byte-identical bytes instead of a new signature per space.
   */
  private async ensureSelfDeviceCert(
    deviceKey: string,
    rootKey: string,
    rootPrivateKey: string,
  ): Promise<DeviceCert> {
    const existing = await this.getDeviceCert(deviceKey);
    if (existing && existing.rootKey === rootKey) return existing;

    const cert = await issueDeviceCert(
      this.driver.crypto,
      rootPrivateKey,
      rootKey,
      deviceKey,
      Date.now(),
    );
    await this.storeDeviceCert(cert);
    return cert;
  }

  /** The root private key, for signing another device's certificate. */
  private async getRootPrivateKey(): Promise<string | null> {
    await this.ensureIdentity();
    const [row] = await this.driver.db.query<{
      root_private_key: string | null;
    }>("SELECT root_private_key FROM identity WHERE id = 1");
    return row?.root_private_key ?? null;
  }

  /**
   * Members of a space, with the personal-space gate applied.
   *
   * The gate is a join, not a filter on ingest: a personal space admits only
   * keys certified under THIS replica's root identity, and `devices` is itself
   * projected from `device_add` ops. So a certificate that arrives after the
   * `member_add` it vouches for silently promotes that member on the next read,
   * with no replay path and no op ever dropped from the log. A shared space
   * (`personal = 0`) is unaffected — every member is visible, as before.
   */
  private async queryVisibleMembers(
    spaceId: string,
    opts: { includeArchived: boolean },
  ): Promise<
    {
      space_id: string;
      public_key: string;
      name: string;
      avatar: string | null;
      added_at: string;
    }[]
  > {
    const [identityRow] = await this.driver.db.query<{
      root_public_key: string | null;
    }>("SELECT root_public_key FROM identity WHERE id = 1");
    const rootKey = identityRow?.root_public_key ?? null;

    return this.driver.db.query(
      `SELECT m.space_id, m.public_key, m.name, m.avatar, m.added_at
         FROM space_members m
         JOIN spaces s ON s.id = m.space_id
         LEFT JOIN devices d ON d.public_key = m.public_key
        WHERE m.space_id = ?
          ${opts.includeArchived ? "" : "AND m.archived_at IS NULL"}
          AND (s.personal = 0 OR (? IS NOT NULL AND d.root_key = ?))
        ORDER BY m.added_at`,
      [spaceId, rootKey, rootKey],
    );
  }

  /**
   * Publish this person's device certificates into a space and make every one
   * of their devices a member of it.
   *
   * Called on space creation, on accepting an invite, and once per space when
   * a new device is linked — the three moments at which "my devices" and "the
   * spaces I'm in" can drift apart. Idempotent: it emits only the `device_add`
   * and `member_add` ops the space's log is missing, so repeated calls after a
   * partial failure converge instead of stacking duplicates.
   */
  private async enrollOwnDevices(spaceId: string): Promise<void> {
    const certs = await this.getOwnDeviceCerts();
    if (certs.length === 0) return;

    const identity = await this.identity.get();
    const published = await this.getPublishedDeviceKeys(spaceId);
    const memberRows = await this.driver.db.query<{ public_key: string }>(
      "SELECT public_key FROM space_members WHERE space_id = ?",
      [spaceId],
    );
    const members = new Set(memberRows.map((r) => r.public_key));

    for (const cert of certs) {
      if (!published.has(cert.deviceKey)) {
        await this.emitSpaceOp(spaceId, {
          op: "device_add",
          rootKey: cert.rootKey,
          deviceKey: cert.deviceKey,
          cert: cert.cert,
          issuedAt: cert.issuedAt,
        });
      }
      if (members.has(cert.deviceKey)) continue;

      // A sibling device carries the same person's name; it is the same human,
      // and member_set propagates any later rename to every one of them.
      await this.driver.db.mutate(
        `INSERT INTO space_members (space_id, public_key, name, added_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(space_id, public_key) DO UPDATE SET archived_at = NULL`,
        [spaceId, cert.deviceKey, identity.name, new Date().toISOString()],
      );
      await this.emitSpaceOp(spaceId, {
        op: "member_add",
        publicKey: cert.deviceKey,
        name: identity.name,
      });
    }
  }

  /**
   * Ensure every space this device belongs to carries its device certificate.
   * Covers the upgrade case (spaces created before device identity existed)
   * and any space adopted from a peer since the last boot.
   */
  private async backfillDeviceEnrollment(): Promise<void> {
    const identity = await this.identity.get();
    if (!identity.rootPublicKey) return;
    const rows = await this.driver.db.query<{ space_id: string }>(
      "SELECT space_id FROM space_members WHERE public_key = ?",
      [identity.publicKey],
    );
    for (const row of rows) {
      try {
        await this.enrollOwnDevices(row.space_id);
      } catch (e) {
        console.warn(
          `[Engine] device enrollment failed for space ${row.space_id}:`,
          e,
        );
      }
    }
  }

  /**
   * Whether recreating `sourceId` into `destSpaceId` crosses out of a personal
   * space into a shared one — the one boundary where history must not travel.
   * Personal → personal keeps the log, since both sides are the same person.
   */
  private async leavesPersonalSpace(
    sourceId: string,
    destSpaceId: string,
  ): Promise<boolean> {
    const sourceSpaceId = await this.getPageSpaceId(sourceId);
    if (!sourceSpaceId || sourceSpaceId === destSpaceId) return false;
    if (!(await this.isPersonalSpace(sourceSpaceId))) return false;
    return !(await this.isPersonalSpace(destSpaceId));
  }

  /**
   * Build a fresh operation log for `targetPageId` from the CURRENT state of
   * `sourceId` — new block ids, new character ids, no tombstones, no drafting
   * history. The published page says what it says today and cannot be replayed
   * backwards into what it used to say.
   */
  private async reoriginateContent(
    sourceId: string,
    targetPageId: string,
  ): Promise<import("@tasfer/editor/state-types").Operation[]> {
    const rebuilt = await this.rebuildBlocksFromOps(sourceId);
    if (!rebuilt) return [];

    const { blocksToOps } = await import("@tasfer/editor/sync/snapshot-diff");
    const { createIdGenerator, generatePeerId } = await import(
      "@tasfer/editor/sync/id"
    );
    const { createHLC, tickHLC } = await import("@tasfer/editor/sync/hlc");

    const peerId = generatePeerId();
    const nextId = createIdGenerator(peerId);
    let hlc = createHLC(peerId);
    const getClock = () => {
      hlc = tickHLC(hlc);
      return hlc;
    };

    return blocksToOps(rebuilt.blocks, {
      pageId: targetPageId,
      peerId,
      nextId,
      getClock,
      schema: appDataSchema,
    });
  }

  /** Whether a space admits only this person's own devices. */
  private async isPersonalSpace(spaceId: string): Promise<boolean> {
    const [row] = await this.driver.db.query<{ personal: number }>(
      "SELECT personal FROM spaces WHERE id = ?",
      [spaceId],
    );
    return row?.personal === 1;
  }

  /** Every certificate issued under this replica's root, oldest device first. */
  private async getOwnDeviceCerts(): Promise<DeviceCert[]> {
    const [identityRow] = await this.driver.db.query<{
      root_public_key: string | null;
    }>("SELECT root_public_key FROM identity WHERE id = 1");
    const rootKey = identityRow?.root_public_key;
    if (!rootKey) return [];
    const rows = await this.driver.db.query<{
      public_key: string;
      root_key: string;
      cert: string;
      issued_at: number;
    }>("SELECT * FROM devices WHERE root_key = ? ORDER BY issued_at", [
      rootKey,
    ]);
    return rows.map((r) => ({
      deviceKey: r.public_key,
      rootKey: r.root_key,
      cert: r.cert,
      issuedAt: r.issued_at,
    }));
  }

  /** Device keys already vouched for in a space's log (any root). */
  private async getPublishedDeviceKeys(spaceId: string): Promise<Set<string>> {
    const rows = await this.driver.db.query<{ target_key: string | null }>(
      "SELECT target_key FROM ops WHERE scope_id = ? AND type = 'device_add'",
      [`space:${spaceId}`],
    );
    return new Set(
      rows
        .map((r) => r.target_key)
        .filter((key): key is string => key !== null),
    );
  }

  /**
   * Resolve device keys to the person who certified them, for callers that
   * group a member list. Keys with no known certificate map to nothing — an
   * uncertified device is displayed as its own member, which is exactly what
   * every member was before device identity existed.
   */
  private async getMemberRootKeys(
    publicKeys: string[],
  ): Promise<Map<string, string>> {
    if (publicKeys.length === 0) return new Map();
    const placeholders = publicKeys.map(() => "?").join(", ");
    const rows = await this.driver.db.query<{
      public_key: string;
      root_key: string;
    }>(
      `SELECT public_key, root_key FROM devices WHERE public_key IN (${placeholders})`,
      publicKeys,
    );
    return new Map(rows.map((r) => [r.public_key, r.root_key]));
  }

  private async getDeviceCert(publicKey: string): Promise<DeviceCert | null> {
    const [row] = await this.driver.db.query<{
      public_key: string;
      root_key: string;
      cert: string;
      issued_at: number;
    }>("SELECT * FROM devices WHERE public_key = ?", [publicKey]);
    if (!row) return null;
    return {
      deviceKey: row.public_key,
      rootKey: row.root_key,
      cert: row.cert,
      issuedAt: row.issued_at,
    };
  }

  /**
   * Cache a verified certificate. First one wins: a device key is bound to one
   * person, and re-binding it later would let a second root claim a device that
   * peers already resolved to the first.
   */
  private async storeDeviceCert(cert: DeviceCert): Promise<void> {
    await this.driver.db.mutate(
      "INSERT OR IGNORE INTO devices (public_key, root_key, cert, issued_at) VALUES (?, ?, ?, ?)",
      [cert.deviceKey, cert.rootKey, cert.cert, cert.issuedAt],
    );
  }

  identity = {
    get: async (): Promise<Identity> => {
      await this.ensureIdentity();
      const rows = await this.driver.db.query<{
        public_key: string;
        name: string;
        avatar: string | null;
        root_public_key: string | null;
      }>(
        "SELECT public_key, name, avatar, root_public_key FROM identity WHERE id = 1",
      );

      const row = rows[0];
      return {
        publicKey: row.public_key,
        name: row.name,
        avatar: row.avatar,
        rootPublicKey: row.root_public_key,
      };
    },

    update: async (data: {
      name?: string;
      avatar?: string | null;
    }): Promise<Identity> => {
      const sets: string[] = [];
      const params: unknown[] = [];

      if (data.name !== undefined) {
        sets.push("name = ?");
        params.push(data.name);
      }
      if (data.avatar !== undefined) {
        sets.push("avatar = ?");
        params.push(data.avatar);
      }

      if (sets.length > 0) {
        await this.driver.db.mutate(
          `UPDATE identity SET ${sets.join(", ")} WHERE id = 1`,
          params,
        );
      }

      // Propagate changes to all spaces the user belongs to
      const identity = await this.identity.get();
      const memberships = await this.driver.db.query<{ space_id: string }>(
        "SELECT space_id FROM space_members WHERE public_key = ? AND archived_at IS NULL",
        [identity.publicKey],
      );
      for (const { space_id } of memberships) {
        if (data.name !== undefined) {
          await this.spaces.updateMember(
            space_id,
            identity.publicKey,
            "name",
            data.name,
          );
        }
        if (data.avatar !== undefined) {
          await this.spaces.updateMember(
            space_id,
            identity.publicKey,
            "avatar",
            data.avatar,
          );
        }
      }

      return identity;
    },
  };

  // ---------------------------------------------------------------------------
  // Peers
  // ---------------------------------------------------------------------------

  peers = {
    list: async (): Promise<Peer[]> => {
      const rows = await this.driver.db.query<{
        public_key: string;
        name: string | null;
        trusted: number;
        last_seen: number | null;
      }>(
        "SELECT public_key, name, trusted, last_seen FROM peers ORDER BY name",
      );

      return rows.map((r) => ({
        publicKey: r.public_key,
        name: r.name ?? "",
        trusted: r.trusted === 1,
        lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
      }));
    },

    trust: async (
      publicKey: string,
      name?: string,
      sharedKey?: string,
    ): Promise<Peer> => {
      const now = Date.now();
      await this.driver.db.mutate(
        `INSERT INTO peers (public_key, name, trusted, shared_key, last_seen) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(public_key) DO UPDATE SET trusted = 1, name = COALESCE(?, name), shared_key = COALESCE(?, shared_key), last_seen = ?`,
        [
          publicKey,
          name ?? "",
          sharedKey ?? null,
          now,
          name ?? null,
          sharedKey ?? null,
          now,
        ],
      );
      const rows = await this.driver.db.query<{
        public_key: string;
        name: string | null;
        trusted: number;
        last_seen: number | null;
      }>("SELECT * FROM peers WHERE public_key = ?", [publicKey]);
      const r = rows[0];
      return {
        publicKey: r.public_key,
        name: r.name ?? "",
        trusted: true,
        lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
      };
    },

    untrust: async (publicKey: string): Promise<void> => {
      await this.driver.db.mutate(
        "UPDATE peers SET trusted = 0 WHERE public_key = ?",
        [publicKey],
      );
    },

    remove: async (publicKey: string): Promise<void> => {
      await this.driver.db.mutate("DELETE FROM peers WHERE public_key = ?", [
        publicKey,
      ]);
    },
  };

  // ---------------------------------------------------------------------------
  // Spaces
  // ---------------------------------------------------------------------------

  spaces = {
    list: async (): Promise<Space[]> => {
      const identity = await this.identity.get();
      const rows = await this.driver.db.query<{
        id: string;
        name: string;
        created_at: string;
        personal: number;
      }>(
        `SELECT s.* FROM spaces s
         JOIN space_members m ON m.space_id = s.id
         WHERE m.public_key = ? AND s.archived_at IS NULL
         ORDER BY s.name`,
        [identity.publicKey],
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        personal: r.personal === 1,
      }));
    },

    listArchived: async (): Promise<ArchivedSpaceItem[]> => {
      const identity = await this.identity.get();
      const rows = await this.driver.db.query<{
        id: string;
        name: string;
        archived_at: string;
      }>(
        `SELECT s.id, s.name, s.archived_at FROM spaces s
         JOIN space_members m ON m.space_id = s.id
         WHERE m.public_key = ? AND s.archived_at IS NOT NULL
         ORDER BY s.archived_at DESC, s.name`,
        [identity.publicKey],
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        archivedAt: r.archived_at,
      }));
    },

    get: async (id: string): Promise<Space & { members: SpaceMember[] }> => {
      const spaceRows = await this.driver.db.query<{
        id: string;
        name: string;
        created_at: string;
        personal: number;
      }>("SELECT * FROM spaces WHERE id = ?", [id]);

      if (spaceRows.length === 0) throw new Error(`Space not found: ${id}`);
      const s = spaceRows[0];

      // Soft-removed members stay in this list for display (unlike the
      // transport's view), but the personal-space gate still applies: a key
      // this replica's root never certified is not a member of a personal
      // space, so it must not be rendered as one either.
      const memberRows = await this.queryVisibleMembers(id, {
        includeArchived: true,
      });
      const rootKeys = await this.getMemberRootKeys(
        memberRows.map((m) => m.public_key),
      );

      return {
        id: s.id,
        name: s.name,
        createdAt: s.created_at,
        personal: s.personal === 1,
        members: memberRows.map((m) => ({
          spaceId: m.space_id,
          publicKey: m.public_key,
          name: m.name,
          avatar: m.avatar,
          addedAt: m.added_at,
          rootKey: rootKeys.get(m.public_key) ?? null,
        })),
      };
    },

    create: async (
      name: string,
      options?: { personal?: boolean },
    ): Promise<Space> => {
      const id = nanoid(10);
      const now = new Date().toISOString();
      const identity = await this.identity.get();
      const personal = options?.personal === true;

      await this.driver.db.mutate(
        "INSERT INTO spaces (id, name, created_at, personal) VALUES (?, ?, ?, ?)",
        [id, name, now, personal ? 1 : 0],
      );

      await this.driver.db.mutate(
        "INSERT INTO space_members (space_id, public_key, name, added_at) VALUES (?, ?, ?, ?)",
        [id, identity.publicKey, identity.name, now],
      );

      // Generate CRDT ops
      await this.emitSpaceOp(id, {
        op: "space_set",
        field: "name",
        value: name,
      });

      // `personal` has to travel with the space, not stay local: your other
      // devices learn about this space from its ops alone, and a sibling that
      // materialized it without the flag would treat it as an ordinary shared
      // space — gate off, invites allowed. Emitted only when true, since the
      // flag is one-way and nothing ever clears it.
      if (personal) {
        await this.emitSpaceOp(id, {
          op: "space_set",
          field: "personal",
          value: true,
        });
      }

      await this.emitSpaceOp(id, {
        op: "member_add",
        publicKey: identity.publicKey,
        name: identity.name,
      });

      // A space created after other devices were linked must reach them too,
      // or "all your spaces" would silently mean "the ones that existed when
      // you linked". enrollOwnDevices covers this device and every sibling.
      await this.enrollOwnDevices(id);

      return { id, name, createdAt: now, personal };
    },

    rename: async (id: string, name: string): Promise<void> => {
      await this.driver.db.mutate("UPDATE spaces SET name = ? WHERE id = ?", [
        name,
        id,
      ]);
      await this.emitSpaceOp(id, {
        op: "space_set",
        field: "name",
        value: name,
      });
      this.notifySpaceChange(id);
    },

    archive: async (id: string): Promise<void> => {
      const now = new Date().toISOString();
      await this.driver.db.mutate(
        "UPDATE spaces SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
        [now, id],
      );
      // An archived space should not accept new members
      await this.pairing.revokeInvite(id);
      await this.replicator?.refreshSpaces();
      this.notifySpaceChange(id);
    },

    unarchive: async (id: string): Promise<void> => {
      await this.driver.db.mutate(
        "UPDATE spaces SET archived_at = NULL WHERE id = ?",
        [id],
      );
      await this.replicator?.refreshSpaces();
      this.notifySpaceChange(id);
    },

    updateMember: async (
      spaceId: string,
      publicKey: string,
      field: string,
      value: unknown,
    ): Promise<void> => {
      await this.emitSpaceOp(spaceId, {
        op: "member_set",
        publicKey,
        field,
        value,
      });
      const memberFieldMap: Record<string, string> = {
        name: "name",
        avatar: "avatar",
      };
      const col = memberFieldMap[field];
      if (col) {
        await this.driver.db.mutate(
          `UPDATE space_members SET ${col} = ? WHERE space_id = ? AND public_key = ?`,
          [value, spaceId, publicKey],
        );
      }
      if (field === "name") {
        await this.driver.db.mutate(
          "UPDATE peers SET name = ? WHERE public_key = ?",
          [value, publicKey],
        );
      }
      this.notifySpaceChange(spaceId);
    },

    onChange: (cb: (spaceId: string) => void): (() => void) => {
      this.spaceChangeListeners.add(cb);
      return () => {
        this.spaceChangeListeners.delete(cb);
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------

  pairing = {
    createInvite: async (
      spaceId: string,
      ttlMs: number,
    ): Promise<SpaceInvite> => {
      // Enforced here, not in the UI. An invite code is a self-describing blob
      // anyone can construct (see app/inviteCode.ts), so hiding the button
      // would hide the affordance without removing the capability — and the
      // guarantee a personal space makes is that this capability does not
      // exist for it at all.
      if (await this.isPersonalSpace(spaceId)) {
        throw new Error(
          `Space ${spaceId} is personal: it admits only your own devices and cannot be invited into`,
        );
      }

      // One pending invite per space — replacing revokes the previous one
      await this.pairing.revokeInvite(spaceId);

      const secretBytes = new Uint8Array(32);
      crypto.getRandomValues(secretBytes);
      const secret = bytesToHex(secretBytes);
      const expiresAt = Date.now() + ttlMs;

      await this.driver.db.mutate(
        "INSERT INTO invites (secret, space_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        [secret, spaceId, new Date().toISOString(), expiresAt],
      );
      const invite = { secret, spaceId, expiresAt };
      try {
        await this.listenForInvite(invite);
      } catch (e) {
        // Offline is fine — the invite stays valid; waitForPeer and startup
        // resume re-arm listening.
        console.warn("[Engine] invite created but listening failed:", e);
      }
      return invite;
    },

    getInvite: async (spaceId: string): Promise<SpaceInvite | null> => {
      const [row] = await this.driver.db.query<{
        secret: string;
        expires_at: number;
      }>("SELECT secret, expires_at FROM invites WHERE space_id = ?", [
        spaceId,
      ]);
      if (!row) return null;
      if (row.expires_at <= Date.now()) {
        await this.pairing.revokeInvite(spaceId);
        return null;
      }
      return { secret: row.secret, spaceId, expiresAt: row.expires_at };
    },

    revokeInvite: async (spaceId: string): Promise<void> => {
      const rows = await this.driver.db.query<{ secret: string }>(
        "SELECT secret FROM invites WHERE space_id = ?",
        [spaceId],
      );
      await this.driver.db.mutate("DELETE FROM invites WHERE space_id = ?", [
        spaceId,
      ]);
      for (const row of rows) {
        this.inviteObservers.delete(row.secret);
        await this.replicator?.cancelPairing(row.secret);
      }
    },

    waitForPeer: async (
      invite: SpaceInvite,
      callbacks?: PairCallbacks,
    ): Promise<void> => {
      if (callbacks) this.inviteObservers.set(invite.secret, callbacks);
      await this.listenForInvite(invite);
    },

    acceptInvite: async (
      invite: SpaceInvite,
      callbacks?: PairCallbacks,
    ): Promise<void> => this._acceptInvite(invite, callbacks),

    cancel: async (invite: SpaceInvite): Promise<void> => {
      this.inviteObservers.delete(invite.secret);
      if (this.replicator) await this.replicator.cancelPairing(invite.secret);
    },

    createDeviceLink: async (ttlMs: number): Promise<SpaceInvite> => {
      // Reuses the invites table with a sentinel space id: `space_id` is UNIQUE,
      // so this also enforces one pending device link at a time, which is what
      // we want for a code that grants the whole account.
      await this.pairing.revokeDeviceLink();

      const secretBytes = new Uint8Array(32);
      crypto.getRandomValues(secretBytes);
      const secret = bytesToHex(secretBytes);
      const expiresAt = Date.now() + ttlMs;

      await this.driver.db.mutate(
        "INSERT INTO invites (secret, space_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        [secret, DEVICE_LINK_SCOPE, new Date().toISOString(), expiresAt],
      );
      const invite = { secret, spaceId: DEVICE_LINK_SCOPE, expiresAt };
      try {
        await this.listenForDeviceLink(invite);
      } catch (e) {
        console.warn("[Engine] device link created but listening failed:", e);
      }
      return invite;
    },

    getDeviceLink: async (): Promise<SpaceInvite | null> => {
      const [row] = await this.driver.db.query<{
        secret: string;
        expires_at: number;
      }>("SELECT secret, expires_at FROM invites WHERE space_id = ?", [
        DEVICE_LINK_SCOPE,
      ]);
      if (!row) return null;
      if (row.expires_at <= Date.now()) {
        await this.pairing.revokeDeviceLink();
        return null;
      }
      return {
        secret: row.secret,
        spaceId: DEVICE_LINK_SCOPE,
        expiresAt: row.expires_at,
      };
    },

    revokeDeviceLink: async (): Promise<void> => {
      const rows = await this.driver.db.query<{ secret: string }>(
        "SELECT secret FROM invites WHERE space_id = ?",
        [DEVICE_LINK_SCOPE],
      );
      await this.driver.db.mutate("DELETE FROM invites WHERE space_id = ?", [
        DEVICE_LINK_SCOPE,
      ]);
      for (const row of rows) {
        this.inviteObservers.delete(row.secret);
        await this.replicator?.cancelPairing(row.secret);
      }
    },

    waitForDevice: async (
      invite: SpaceInvite,
      callbacks?: PairCallbacks,
    ): Promise<void> => {
      if (callbacks) this.inviteObservers.set(invite.secret, callbacks);
      await this.listenForDeviceLink(invite);
    },

    acceptDeviceLink: async (
      invite: SpaceInvite,
      callbacks?: PairCallbacks,
    ): Promise<void> => {
      invariant(this.replicator, "Replicator not initialized");
      const identity = await this.identity.get();
      const privateKey = await this.getPrivateKey();

      await this.replicator.startPairing({
        invite,
        role: "acceptor",
        mode: "device",
        localPublicKey: identity.publicKey,
        localName: identity.name,
        privateKey,
        callbacks: {
          onConnected: callbacks?.onConnected,
          onPeerIdentity: callbacks?.onPeerIdentity,
          onComplete: async (peer) => {
            // Trust only; the enrolment payload that follows carries the root
            // identity and space rows this device needs.
            const sharedKey = await deriveSharedSignalingKey(
              invite.secret,
              identity.publicKey,
              peer.publicKey,
            );
            await this.peers.trust(peer.publicKey, peer.name, sharedKey);
            callbacks?.onComplete?.(peer);
          },
          onError: callbacks?.onError,
        },
        applyDeviceLink: (payload) => this.applyDeviceLink(payload),
      });
    },
  };

  /**
   * UI callbacks attached to a listening invite (latest attach wins).
   * Sessions are engine-owned and outlive any dialog; observers only add
   * feedback, looked up at fire time so a dead tab's callbacks are skipped.
   */
  private inviteObservers = new Map<string, PairCallbacks>();

  /** In-flight session starts, so concurrent callers share one attempt. */
  private inviteListens = new Map<string, Promise<void>>();

  /**
   * Ensure a pairing session is listening for acceptors of this invite
   * (inviter side). Idempotent; runs multi-peer until the invite expires or
   * is revoked.
   */
  private listenForInvite = async (invite: SpaceInvite): Promise<void> => {
    if (this.replicator?.isPairingActive(invite.secret)) return;
    const pending = this.inviteListens.get(invite.secret);
    if (pending) return pending;
    const listen = this.startInviteSession(invite).finally(() => {
      this.inviteListens.delete(invite.secret);
    });
    this.inviteListens.set(invite.secret, listen);
    return listen;
  };

  private startInviteSession = async (invite: SpaceInvite): Promise<void> => {
    invariant(this.replicator, "Replicator not initialized");
    const identity = await this.identity.get();
    const privateKey = await this.getPrivateKey();
    const space = await this.spaces.get(invite.spaceId);
    const observer = () => this.inviteObservers.get(invite.secret);

    await this.replicator.startPairing({
      invite,
      role: "initiator",
      spaceName: space.name,
      localPublicKey: identity.publicKey,
      localName: identity.name,
      privateKey,
      callbacks: {
        onConnected: () => observer()?.onConnected?.(),
        onPeerIdentity: (peer) => observer()?.onPeerIdentity?.(peer),
        onComplete: async (peer) => {
          // Derive shared signaling key from pairing secret + both public keys
          const sharedKey = await deriveSharedSignalingKey(
            invite.secret,
            identity.publicKey,
            peer.publicKey,
          );
          await this.peers.trust(peer.publicKey, peer.name, sharedKey);
          // Insert member into DB first so recomputeSharedSpaces (triggered
          // by emitSpaceOp -> addPeer) can find this peer in the space.
          await this.driver.db.mutate(
            `INSERT INTO space_members (space_id, public_key, name, added_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(space_id, public_key) DO UPDATE SET name = ?, archived_at = NULL`,
            [
              invite.spaceId,
              peer.publicKey,
              peer.name,
              new Date().toISOString(),
              peer.name,
            ],
          );
          await this.emitSpaceOp(invite.spaceId, {
            op: "member_add",
            publicKey: peer.publicKey,
            name: peer.name,
          });
          this.notifySpaceChange(invite.spaceId);
          observer()?.onComplete?.(peer);
        },
        onError: (error) => observer()?.onError?.(error),
      },
    });
  };

  /**
   * Ensure a device-link session is listening (existing-device side).
   * Same idempotence contract as {@link listenForInvite}, on its own topic.
   */
  private listenForDeviceLink = async (invite: SpaceInvite): Promise<void> => {
    if (this.replicator?.isPairingActive(invite.secret)) return;
    const pending = this.inviteListens.get(invite.secret);
    if (pending) return pending;
    const listen = this.startDeviceLinkSession(invite).finally(() => {
      this.inviteListens.delete(invite.secret);
    });
    this.inviteListens.set(invite.secret, listen);
    return listen;
  };

  private startDeviceLinkSession = async (
    invite: SpaceInvite,
  ): Promise<void> => {
    invariant(this.replicator, "Replicator not initialized");
    const identity = await this.identity.get();
    const privateKey = await this.getPrivateKey();
    const observer = () => this.inviteObservers.get(invite.secret);

    await this.replicator.startPairing({
      invite,
      role: "initiator",
      mode: "device",
      localPublicKey: identity.publicKey,
      localName: identity.name,
      privateKey,
      callbacks: {
        onConnected: () => observer()?.onConnected?.(),
        onPeerIdentity: (peer) => observer()?.onPeerIdentity?.(peer),
        onComplete: async (peer) => {
          const sharedKey = await deriveSharedSignalingKey(
            invite.secret,
            identity.publicKey,
            peer.publicKey,
          );
          await this.peers.trust(peer.publicKey, peer.name, sharedKey);
          observer()?.onComplete?.(peer);
        },
        onError: (error) => observer()?.onError?.(error),
      },
      // Enrolment runs from here rather than onComplete: the certificate must
      // exist and be published to every space before the payload goes out, so
      // the newcomer's first sync already finds itself a member.
      issueDeviceLink: (peerPublicKey) =>
        this.issueDeviceLink(peerPublicKey, observer()),
    });
  };

  /**
   * Certify a new device under this person's root, enrol it into every space,
   * and assemble the payload it needs to become a peer.
   */
  private async issueDeviceLink(
    peerPublicKey: string,
    observer?: PairCallbacks,
  ): Promise<DeviceLinkPayload | null> {
    const identity = await this.identity.get();
    const rootPrivateKey = await this.getRootPrivateKey();
    if (!identity.rootPublicKey || !rootPrivateKey) {
      observer?.onError?.("This device has no root identity to link with");
      return null;
    }
    if (!isDeviceKeyShaped(peerPublicKey)) {
      observer?.onError?.("The joining device presented an unusable key");
      return null;
    }

    const cert = await issueDeviceCert(
      this.driver.crypto,
      rootPrivateKey,
      identity.rootPublicKey,
      peerPublicKey,
      Date.now(),
    );
    await this.storeDeviceCert(cert);

    // Publish into every space, personal ones included — a linked device that
    // only received some of them would not be this person's device, just a
    // well-connected stranger.
    const spaceRows = await this.driver.db.query<{
      id: string;
      name: string;
      personal: number;
    }>(
      `SELECT s.id, s.name, s.personal FROM spaces s
         JOIN space_members m ON m.space_id = s.id
        WHERE m.public_key = ?`,
      [identity.publicKey],
    );
    for (const space of spaceRows) {
      await this.enrollOwnDevices(space.id);
      this.notifySpaceChange(space.id);
    }

    return {
      rootPublicKey: identity.rootPublicKey,
      rootPrivateKey,
      cert: cert.cert,
      issuedAt: cert.issuedAt,
      deviceCerts: (await this.getOwnDeviceCerts()).map((c) => ({
        deviceKey: c.deviceKey,
        cert: c.cert,
        issuedAt: c.issuedAt,
      })),
      spaces: spaceRows.map((s) => ({
        id: s.id,
        name: s.name,
        personal: s.personal === 1,
      })),
    };
  }

  /**
   * Adopt an enrolment payload as the newly linked device.
   *
   * Writes rows only — no ops. Every fact here already exists as a `device_add`
   * or `member_add` in the sender's log and arrives again through normal
   * replication; this is the local bootstrap that lets replication start at
   * all, mirroring what `_acceptInvite` does for a single space.
   */
  private async applyDeviceLink(payload: DeviceLinkPayload): Promise<void> {
    const identity = await this.identity.get();

    const selfCert: DeviceCert = {
      rootKey: payload.rootPublicKey,
      deviceKey: identity.publicKey,
      cert: payload.cert,
      issuedAt: payload.issuedAt,
    };
    if (!(await verifyDeviceCert(this.driver.crypto, selfCert))) {
      throw new Error("Device certificate from the linking device is invalid");
    }

    await this.driver.db.mutate(
      "UPDATE identity SET root_public_key = ?, root_private_key = ? WHERE id = 1",
      [payload.rootPublicKey, payload.rootPrivateKey],
    );
    // This device already self-certified under the throwaway root it generated
    // on first boot, and storeDeviceCert is first-wins — so the new binding
    // would be silently ignored, leaving the device uncertified under the
    // identity it just adopted and locked out of its own personal spaces.
    // Adopting an identity is the one sanctioned re-binding, and it is local
    // and user-initiated, so clear the stale row first.
    await this.driver.db.mutate("DELETE FROM devices WHERE public_key = ?", [
      identity.publicKey,
    ]);
    await this.storeDeviceCert(selfCert);

    for (const entry of payload.deviceCerts) {
      const cert: DeviceCert = {
        rootKey: payload.rootPublicKey,
        deviceKey: entry.deviceKey,
        cert: entry.cert,
        issuedAt: entry.issuedAt,
      };
      if (await verifyDeviceCert(this.driver.crypto, cert)) {
        await this.storeDeviceCert(cert);
      } else {
        console.warn(
          `[Engine] discarded unverifiable sibling cert for ${entry.deviceKey.slice(0, 8)}`,
        );
      }
    }

    const now = new Date().toISOString();
    for (const space of payload.spaces) {
      await this.driver.db.mutate(
        `INSERT INTO spaces (id, name, created_at, personal) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET archived_at = NULL`,
        [space.id, space.name, now, space.personal ? 1 : 0],
      );
      // Both this device and every sibling, so the personal-space gate has
      // something to admit before the first sync arrives.
      for (const deviceKey of [
        identity.publicKey,
        ...payload.deviceCerts.map((c) => c.deviceKey),
      ]) {
        await this.driver.db.mutate(
          `INSERT INTO space_members (space_id, public_key, name, added_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(space_id, public_key) DO UPDATE SET archived_at = NULL`,
          [space.id, deviceKey, identity.name, now],
        );
      }
      this.notifySpaceChange(space.id);
    }
  }

  private _acceptInvite = async (
    invite: SpaceInvite,
    callbacks?: PairCallbacks,
  ): Promise<void> => {
    invariant(this.replicator, "Replicator not initialized");
    const identity = await this.identity.get();
    const privateKey = await this.getPrivateKey();

    await this.replicator.startPairing({
      invite,
      role: "acceptor",
      localPublicKey: identity.publicKey,
      localName: identity.name,
      privateKey,
      callbacks: {
        onConnected: callbacks?.onConnected,
        onPeerIdentity: callbacks?.onPeerIdentity,
        onComplete: async (peer, spaceName) => {
          // Derive shared signaling key from pairing secret + both public keys
          const sharedKey = await deriveSharedSignalingKey(
            invite.secret,
            identity.publicKey,
            peer.publicKey,
          );
          await this.peers.trust(peer.publicKey, peer.name, sharedKey);

          // Create the space locally from invite metadata
          const now = new Date().toISOString();
          await this.driver.db.mutate(
            `INSERT INTO spaces (id, name, created_at) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET archived_at = NULL`,
            [invite.spaceId, spaceName ?? "", now],
          );
          // Add self as member
          await this.driver.db.mutate(
            `INSERT INTO space_members (space_id, public_key, name, added_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(space_id, public_key) DO UPDATE SET name = ?, archived_at = NULL`,
            [
              invite.spaceId,
              identity.publicKey,
              identity.name,
              now,
              identity.name,
            ],
          );
          // Add the initiator as member (so hello exchange can identify shared spaces)
          await this.driver.db.mutate(
            `INSERT INTO space_members (space_id, public_key, name, added_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(space_id, public_key) DO UPDATE SET name = ?, archived_at = NULL`,
            [invite.spaceId, peer.publicKey, peer.name, now, peer.name],
          );

          // Publish this person's certificates into the space we just joined,
          // and bring their other devices in with them. Without this the
          // inviter would see one member per device of ours, unable to tell
          // they are the same person.
          await this.enrollOwnDevices(invite.spaceId);

          // Replicator.addPeer is called automatically after pairing completes
          this.notifySpaceChange(invite.spaceId);
          callbacks?.onComplete?.(peer, spaceName);
        },
        onError: callbacks?.onError,
      },
    });
  };

  /** Re-listen for persisted invites after startup; drops expired ones. */
  async resumePendingInvites(): Promise<void> {
    const rows = await this.driver.db.query<{
      secret: string;
      space_id: string;
      expires_at: number;
    }>("SELECT secret, space_id, expires_at FROM invites");

    for (const row of rows) {
      if (row.expires_at <= Date.now()) {
        await this.driver.db.mutate("DELETE FROM invites WHERE secret = ?", [
          row.secret,
        ]);
        continue;
      }
      const invite = {
        secret: row.secret,
        spaceId: row.space_id,
        expiresAt: row.expires_at,
      };
      try {
        // A device link listens on its own topic and has no space to read a
        // name from, so it cannot go through the space-invite path.
        if (row.space_id === DEVICE_LINK_SCOPE) {
          await this.listenForDeviceLink(invite);
        } else {
          await this.listenForInvite(invite);
        }
      } catch (e) {
        console.warn(
          `[Engine] failed to resume invite for space ${row.space_id}:`,
          e,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------------

  pages = {
    list: async (
      spaceId: string,
      parentId?: string | null,
      options?: { includeTasks?: boolean },
    ): Promise<PageListItem[]> => {
      let sql: string;
      const params: unknown[] = [];

      if (parentId === null || parentId === undefined) {
        sql = `SELECT p.*, EXISTS(SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.archived_at IS NULL) as has_children
               FROM pages p WHERE p.space_id = ? AND p.parent_id IS NULL AND p.archived_at IS NULL`;
        params.push(spaceId);
      } else {
        sql = `SELECT p.*, EXISTS(SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.archived_at IS NULL) as has_children
               FROM pages p WHERE p.space_id = ? AND p.parent_id = ? AND p.archived_at IS NULL`;
        params.push(spaceId, parentId);
      }

      if (!options?.includeTasks) {
        sql += " AND p.task = 0";
      }

      // Tiebreak on id so duplicate/equal order values sort deterministically
      // across peers (ordering must be a pure function of stored state).
      sql += ' ORDER BY p."order" ASC, p.id ASC';

      const rows = await this.driver.db.query<{
        id: string;
        title: string;
        title_md: string;
        parent_id: string | null;
        order: number;
        has_children: number;
        space_id: string | null;
        task: number;
        color: string | null;
        scheduled_at: string | null;
        duration: number | null;
        all_day: number | null;
        recurrence_id: string | null;
      }>(sql, params);

      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        titleMd: r.title_md,
        parentId: r.parent_id,
        order: r.order,
        hasChildren: r.has_children === 1,
        spaceId: r.space_id,
        task: r.task === 1,
        color: r.color,
        scheduledAt: r.scheduled_at,
        duration: r.duration,
        allDay: r.all_day === null ? null : r.all_day === 1,
        recurrenceId: r.recurrence_id,
      }));
    },

    get: async (id: string): Promise<PageFull> => {
      const rows = await this.driver.db.query<{
        id: string;
        title: string;
        title_md: string;
        parent_id: string | null;
        order: number;
        has_children: number;
        space_id: string | null;
        task: number;
        color: string | null;
        scheduled_at: string | null;
        duration: number | null;
        all_day: number | null;
        recurrence_id: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT p.*, EXISTS(SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.archived_at IS NULL) as has_children
         FROM pages p WHERE p.id = ? AND p.archived_at IS NULL`,
        [id],
      );

      if (rows.length === 0) {
        throw new Error(`Page not found: ${id}`);
      }

      const r = rows[0];

      // Fast path: use the filesystem snapshot only when its recorded version
      // vector exactly matches the op log's current frontier. Rebuilding from
      // all ops is expensive on mobile — the snapshot lets us skip it when
      // nothing has changed since the last save. A version vector (not a raw op
      // count) is required: the snapshot's blocks and its validity token must
      // describe the same op set, and a count read independently of the blocks
      // can match while the blocks are stale (see snapshots.save).
      const currentVV = await this.pageClockVV(id);
      const cached = await this.loadSnapshot(id);
      let blocks:
        | import("@tasfer/editor/serlization/loadPage").Block[]
        | null = null;
      if (cached && vvEqual(cached.vv, currentVV) && cached.blocks.length > 0) {
        blocks = cached.blocks;
        // Free (blocks in hand, no op-log replay): reconcile the derived title
        // columns against the doc on every open, not only the slow rebuild path
        // below. A page whose title_md drifted from the doc — e.g. one saved
        // before a title-projection change, or edited only through a surface
        // that never wrote the columns — would otherwise stay stale forever,
        // since a warm snapshot cache skips the rebuild that used to heal it.
        this.refreshDerivedTitlesFromBlocks(id, blocks).catch(() => {});
      } else {
        // Slow path: replay full op log and persist a fresh snapshot. The saved
        // vv is derived from the exact ops the rebuild consumed, so it always
        // describes the blocks it ships with.
        const rebuilt = await this.rebuildBlocksFromOps(id);
        blocks = rebuilt?.blocks ?? null;
        if (rebuilt && blocks && blocks.length > 0) {
          // Fire-and-forget — don't block the page open on the write.
          this.snapshots.save(id, blocks, rebuilt.vv).catch(() => {});
          // Free (blocks in hand): catch the derived title columns up to the
          // doc if they went stale (e.g. ops applied while the app was closed).
          this.refreshDerivedTitlesFromBlocks(id, blocks).catch(() => {});
        }
      }

      if (!blocks || blocks.length === 0) {
        // Truly empty page — create default block and persist its
        // block_insert op so the block survives rebuild-from-ops.
        // Derive blockId deterministically from pageId so every peer
        // independently creates the exact same initial block.
        const initialBlockId = `__init_block__:${id}`;
        blocks = [
          {
            id: initialBlockId,
            type: "heading1",
            charRuns: [],
            formats: [],
          },
        ];

        const blockInsertOp = {
          op: "block_insert" as const,
          id: `__init__:0`,
          clock: { counter: 0, peerId: "__init__" },
          pageId: id,
          // Canonical first fractional-index key (generateKeyBetween(null, null)).
          orderKey: "a0",
          blockId: initialBlockId,
          blockType: "heading1" as const,
        };
        const opData = new TextEncoder().encode(JSON.stringify(blockInsertOp));
        await this.driver.db.mutate(
          "INSERT OR IGNORE INTO ops (scope_id, peer_id, clock, type, data, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
          [id, "__init__", 0, "block_insert", opData, Date.now()],
        );
      }

      const parents = await this.buildParentChain(r.parent_id);

      return {
        id: r.id,
        title: r.title,
        titleMd: r.title_md,
        parentId: r.parent_id,
        order: r.order,
        hasChildren: r.has_children === 1,
        spaceId: r.space_id,
        task: r.task === 1,
        color: r.color,
        scheduledAt: r.scheduled_at,
        duration: r.duration,
        allDay: r.all_day === null ? null : r.all_day === 1,
        recurrenceId: r.recurrence_id,
        blocks,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        parents,
      };
    },

    create: async (data: PageCreateInput): Promise<PageFull> => {
      const id = nanoid(10);
      const now = new Date().toISOString();
      const scheduledAt = toUtcIso(data.scheduledAt);

      const orderRows = await this.driver.db.query<{
        max_order: number | null;
      }>(
        data.parentId
          ? 'SELECT MAX("order") as max_order FROM pages WHERE parent_id = ? AND archived_at IS NULL'
          : 'SELECT MAX("order") as max_order FROM pages WHERE parent_id IS NULL AND archived_at IS NULL',
        data.parentId ? [data.parentId] : [],
      );
      const order = (orderRows[0]?.max_order ?? 0) + 1;

      await this.driver.db.mutate(
        `INSERT INTO pages (id, title, title_md, parent_id, "order", space_id, task, scheduled_at, duration, all_day, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          data.title,
          data.titleMd ?? "",
          data.parentId,
          order,
          data.spaceId ?? null,
          data.task ? 1 : 0,
          scheduledAt,
          data.duration ?? null,
          data.allDay !== undefined ? (data.allDay ? 1 : 0) : null,
          now,
          now,
        ],
      );

      // Derive blockId deterministically from pageId so every peer
      // independently creates the exact same initial block.
      const initialBlockId = `__init_block__:${id}`;

      // Persist a block_insert op for the initial block
      const blockInsertOp = {
        op: "block_insert" as const,
        id: `__init__:0`,
        clock: { counter: 0, peerId: "__init__" },
        pageId: id,
        // Canonical first fractional-index key (generateKeyBetween(null, null)).
        orderKey: "a0",
        blockId: initialBlockId,
        blockType: "heading1" as const,
      };
      const opData = new TextEncoder().encode(JSON.stringify(blockInsertOp));
      await this.driver.db.mutate(
        "INSERT OR IGNORE INTO ops (scope_id, peer_id, clock, type, data, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        [id, "__init__", 0, "block_insert", opData, Date.now()],
      );

      // Auto-generate space op if page belongs to a space
      if (data.spaceId) {
        await this.emitSpaceOp(data.spaceId, {
          op: "page_add",
          pageId: id,
          parentId: data.parentId,
          order,
          task: data.task,
          color: undefined,
          scheduledAt,
          duration: data.duration ?? null,
          allDay: data.allDay ?? null,
        });

        // Push the initial block op to already-connected peers so they don't
        // have to wait for a full re-sync to see the new page's structure.
        this.replicator?.pushPageOps(data.spaceId, id, [blockInsertOp]);

        // Wake local listeners (e.g. other browser tabs sharing this engine)
        // so their page list refreshes immediately. emitSpaceOp only stores
        // the op and pushes to remote peers; it does not notify locally.
        this.notifySpaceChange(data.spaceId);
      }

      return this.pages.get(id);
    },

    update: async (data: PageUpdateInput): Promise<PageFull> => {
      const sets: string[] = [];
      const params: unknown[] = [];

      // Track which fields changed for space ops. The title columns are NOT
      // tracked here: they are local caches derived from the doc, whose ops
      // are the source of truth — peers re-derive them from content ops
      // (refreshDerivedTitles) instead of receiving them as metadata.
      const changedFields: { field: string; value: unknown }[] = [];
      let titleChanged = false;

      if (data.title !== undefined) {
        sets.push("title = ?");
        params.push(data.title);
        titleChanged = true;
      }
      if (data.titleMd !== undefined) {
        sets.push("title_md = ?");
        params.push(data.titleMd);
        titleChanged = true;
      }
      if (data.color !== undefined) {
        sets.push("color = ?");
        params.push(data.color);
        changedFields.push({ field: "color", value: data.color });
      }
      if (data.scheduledAt !== undefined) {
        const scheduledAt = toUtcIso(data.scheduledAt);
        sets.push("scheduled_at = ?");
        params.push(scheduledAt);
        changedFields.push({ field: "scheduledAt", value: scheduledAt });
      }
      if (data.duration !== undefined) {
        sets.push("duration = ?");
        params.push(data.duration);
        changedFields.push({ field: "duration", value: data.duration });
      }
      if (data.allDay !== undefined) {
        sets.push("all_day = ?");
        params.push(data.allDay === null ? null : data.allDay ? 1 : 0);
        changedFields.push({ field: "allDay", value: data.allDay });
      }
      if (data.task !== undefined) {
        sets.push("task = ?");
        params.push(data.task ? 1 : 0);
        changedFields.push({ field: "task", value: data.task });
      }

      if (sets.length > 0) {
        sets.push("updated_at = ?");
        params.push(new Date().toISOString());
        params.push(data.id);
        await this.driver.db.mutate(
          `UPDATE pages SET ${sets.join(", ")} WHERE id = ?`,
          params,
        );
      }

      // Auto-generate space ops for metadata changes
      if (changedFields.length > 0 || titleChanged) {
        const spaceId = await this.getPageSpaceId(data.id);
        if (spaceId) {
          for (const { field, value } of changedFields) {
            await this.emitSpaceOp(spaceId, {
              op: "page_set",
              pageId: data.id,
              field,
              value,
            });
          }
          // Title-only changes emit no ops, but still wake local listeners
          // (other tabs sharing this engine) so their page lists refresh.
          this.notifySpaceChange(spaceId);
        }
      }

      return this.pages.get(data.id);
    },

    delete: async (id: string): Promise<void> => {
      // Check if page belongs to a space before deleting
      const spaceId = await this.getPageSpaceId(id);

      const tree = await this.driver.db.query<{ id: string }>(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM pages WHERE id = ? AND archived_at IS NULL
           UNION ALL
           SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id WHERE p.archived_at IS NULL
         )
         SELECT id FROM subtree`,
        [id],
      );
      const ids = tree.map((r) => r.id);

      const placeholders = ids.map(() => "?").join(", ");
      const now = new Date().toISOString();

      await this.driver.db.mutate(
        `UPDATE pages SET archived_at = ? WHERE id IN (${placeholders}) AND archived_at IS NULL`,
        [now, ...ids],
      );

      // Generate space op for each deleted page
      if (spaceId) {
        for (const pageId of ids) {
          await this.emitSpaceOp(spaceId, { op: "page_remove", pageId });
        }
        this.notifySpaceChange(spaceId);
      }

      // Notify page delete listeners (so the editor can react if the deleted page is open)
      for (const pageId of ids) {
        this.notifyPageDeleted(pageId);
      }
    },

    listArchived: async (): Promise<ArchivedPageItem[]> => {
      // Roots of archived subtrees across every space: a page is a "root" if it
      // has no parent, or its parent is not itself archived. This shows each
      // deletion the user performed once, instead of every descendant of a
      // deleted subtree as a separate entry.
      //
      // Pages whose space is archived are excluded: an archived space is hidden
      // as a whole (see spaces.listArchived in the Archive), and restoring the space
      // brings its still-live pages back. Listing those pages' individually
      // deleted members here would let them be restored into a hidden space.
      const rows = await this.driver.db.query<{
        id: string;
        title: string;
        title_md: string;
        space_id: string | null;
        color: string | null;
        archived_at: string;
      }>(
        `SELECT p.id, p.title, p.title_md, p.space_id, p.color, p.archived_at
           FROM pages p
           LEFT JOIN pages parent ON p.parent_id = parent.id
           LEFT JOIN spaces sp ON p.space_id = sp.id
          WHERE p.archived_at IS NOT NULL
            AND (p.parent_id IS NULL OR parent.archived_at IS NULL)
            AND (p.space_id IS NULL OR sp.archived_at IS NULL)
          ORDER BY p.archived_at DESC, p.id ASC`,
      );

      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        titleMd: r.title_md,
        spaceId: r.space_id,
        color: r.color,
        archivedAt: r.archived_at,
      }));
    },

    restore: async (id: string): Promise<void> => {
      const spaceId = await this.getPageSpaceId(id);

      // Collect the archived subtree rooted at `id` (mirror of delete's CTE,
      // walking archived rows instead of live ones).
      const subtree = await this.driver.db.query<{
        id: string;
        parent_id: string | null;
        order: number;
        task: number;
        color: string | null;
        scheduled_at: string | null;
        duration: number | null;
        all_day: number | null;
      }>(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM pages WHERE id = ? AND archived_at IS NOT NULL
           UNION ALL
           SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id WHERE p.archived_at IS NOT NULL
         )
         SELECT p.id, p.parent_id, p."order" as "order", p.task,
                p.color, p.scheduled_at, p.duration, p.all_day
           FROM pages p JOIN subtree s ON p.id = s.id`,
        [id],
      );

      if (subtree.length === 0) return;

      const ids = subtree.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(", ");
      const now = new Date().toISOString();

      // Un-archive the whole subtree locally.
      await this.driver.db.mutate(
        `UPDATE pages SET archived_at = NULL, updated_at = ? WHERE id IN (${placeholders})`,
        [now, ...ids],
      );

      // If the restored root's parent is gone (still archived or deleted), drop
      // the root to the top level so it isn't orphaned under an invisible page.
      const root = subtree.find((r) => r.id === id)!;
      let reparented = false;
      if (root.parent_id !== null) {
        const parentRows = await this.driver.db.query<{ archived_at: string | null }>(
          "SELECT archived_at FROM pages WHERE id = ?",
          [root.parent_id],
        );
        const parentAlive = parentRows.length > 0 && parentRows[0].archived_at === null;
        if (!parentAlive) {
          await this.driver.db.mutate(
            `UPDATE pages SET parent_id = NULL, updated_at = ? WHERE id = ?`,
            [now, id],
          );
          root.parent_id = null;
          reparented = true;
        }
      }

      // Propagate to peers. A fresh page_add (higher HLC than the prior
      // page_remove) un-archives the row on every peer via the existing
      // un-archive branch in applySpaceOp. Emit these before the reparent
      // page_set so the row is alive when the reparent op applies.
      if (spaceId) {
        for (const r of subtree) {
          await this.emitSpaceOp(spaceId, {
            op: "page_add",
            pageId: r.id,
            parentId: r.parent_id,
            order: r.order,
            task: r.task === 1,
            color: r.color,
            scheduledAt: r.scheduled_at,
            duration: r.duration,
            allDay: r.all_day === null ? null : r.all_day === 1,
          });
        }
        if (reparented) {
          await this.emitSpaceOp(spaceId, {
            op: "page_set",
            pageId: id,
            field: "parentId",
            value: null,
          });
        }
        this.notifySpaceChange(spaceId);
      }
    },

    // In-space reparent/reorder only. A cross-space move is not a reparent: it
    // recreates the dragged subtree as fresh pages in the target space (new
    // ids, copied content) and removes the originals — see recreateInSpace /
    // purgeMovedSubtree, orchestrated by the app layer (src/lib/spaceMove.ts)
    // so it can drive a progress bar over large subtrees.
    move: async (data: PageMoveInput): Promise<void> => {
      const spaceId = await this.getPageSpaceId(data.id);

      // When no explicit order is supplied (e.g. nesting a page under a new
      // parent), append it to the end of the destination's children. Without
      // this the page would keep its old order value, which is meaningless in
      // the new sibling set and collides arbitrarily.
      let order = data.order;
      if (order === undefined) {
        const orderRows = await this.driver.db.query<{
          max_order: number | null;
        }>(
          data.parentId === null
            ? 'SELECT MAX("order") as max_order FROM pages WHERE parent_id IS NULL AND id != ? AND archived_at IS NULL'
            : 'SELECT MAX("order") as max_order FROM pages WHERE parent_id = ? AND id != ? AND archived_at IS NULL',
          data.parentId === null ? [data.id] : [data.parentId, data.id],
        );
        order = (orderRows[0]?.max_order ?? 0) + 1;
      }

      await this.driver.db.mutate(
        `UPDATE pages SET parent_id = ?, "order" = ?, updated_at = ? WHERE id = ?`,
        [data.parentId, order, new Date().toISOString(), data.id],
      );

      if (spaceId) {
        await this.emitSpaceOp(spaceId, {
          op: "page_set",
          pageId: data.id,
          field: "parentId",
          value: data.parentId,
        });
        await this.emitSpaceOp(spaceId, {
          op: "page_set",
          pageId: data.id,
          field: "order",
          value: order,
        });
        this.notifySpaceChange(spaceId);
      }
    },

    // --- Cross-space move (recreate model) ------------------------------------
    // A page belongs to exactly one space, keyed by its id, and its content ops
    // are scoped by that id. Rather than smuggle a shared id between two space
    // logs (which forces an unresolvable page_add/page_remove race for peers in
    // both spaces), a cross-space move recreates the subtree as fresh pages in
    // the destination, then tombstones the originals via the normal delete()
    // path. Each space then cleanly owns its own ids. The app layer orchestrates
    // subtree() + recreateInSpace() so it can show progress over a large
    // subtree; source removal reuses delete() (ops are never hard-deleted — the
    // op log is the source of truth, and removal is a tombstone).

    subtree: async (pageId: string): Promise<PageSubtreeItem[]> => {
      // Depth orders the rows parent-before-child, so the orchestrator can
      // recreate a parent (and learn its new id) before any of its children.
      const rows = await this.driver.db.query<{
        id: string;
        parent_id: string | null;
        order: number;
      }>(
        `WITH RECURSIVE subtree(id, parent_id, "order", depth) AS (
           SELECT id, parent_id, "order", 0 FROM pages
             WHERE id = ? AND archived_at IS NULL
           UNION ALL
           SELECT p.id, p.parent_id, p."order", s.depth + 1
             FROM pages p JOIN subtree s ON p.parent_id = s.id
             WHERE p.archived_at IS NULL
         )
         SELECT id, parent_id, "order" FROM subtree ORDER BY depth, "order"`,
        [pageId],
      );
      return rows.map((r) => ({
        id: r.id,
        parentId: r.parent_id,
        order: r.order,
      }));
    },

    recreateInSpace: async (input: RecreatePageInput): Promise<string> => {
      const src = await this.driver.db.query<{
        title: string;
        title_md: string;
        body_text: string | null;
        task: number;
        color: string | null;
        scheduled_at: string | null;
        duration: number | null;
        all_day: number | null;
        recurrence_id: string | null;
      }>(
        `SELECT title, title_md, body_text, task, color, scheduled_at,
                duration, all_day, recurrence_id
           FROM pages WHERE id = ?`,
        [input.sourceId],
      );
      invariant(src.length > 0, "recreateInSpace: source page not found");
      const s = src[0];

      const newId = nanoid(10);
      const now = new Date().toISOString();

      // Append to the end of the destination's children when no order is given
      // (a "nest under this parent" drop), mirroring pages.move.
      let order = input.order;
      if (order === undefined) {
        const orderRows = await this.driver.db.query<{
          max_order: number | null;
        }>(
          input.parentId === null
            ? 'SELECT MAX("order") as max_order FROM pages WHERE parent_id IS NULL AND space_id IS ? AND archived_at IS NULL'
            : 'SELECT MAX("order") as max_order FROM pages WHERE parent_id = ? AND archived_at IS NULL',
          input.parentId === null ? [input.spaceId] : [input.parentId],
        );
        order = (orderRows[0]?.max_order ?? 0) + 1;
      }

      // Copy the row verbatim into the target space, overriding only identity,
      // placement, and timestamps. Title/body columns are carried over so the
      // page shows correctly in the list immediately, without waiting for the
      // async title re-derive.
      await this.driver.db.mutate(
        `INSERT INTO pages (id, title, title_md, body_text, parent_id, "order",
                            space_id, task, color, scheduled_at, duration,
                            all_day, recurrence_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId,
          s.title,
          s.title_md,
          s.body_text,
          input.parentId,
          order,
          input.spaceId,
          s.task,
          s.color,
          s.scheduled_at,
          s.duration,
          s.all_day,
          s.recurrence_id,
          now,
          now,
        ],
      );

      // Copy the content ops under the new page's scope. Block ids are
      // page-local, so duplicating them into a distinct scope is safe.
      //
      // Leaving a personal space is the exception. The op log holds every
      // keystroke ever made on the page — tombstoned characters included — so
      // copying it verbatim would hand the destination's members the page's
      // entire drafting history, which is exactly what a personal space exists
      // to prevent. Re-originate instead: rebuild the page's CURRENT blocks and
      // emit fresh ops for them, the same way import writes a new document.
      const contentOps = (await this.leavesPersonalSpace(
        input.sourceId,
        input.spaceId,
      ))
        ? await this.reoriginateContent(input.sourceId, newId)
        : await this.ops.load(input.sourceId);
      if (contentOps.length > 0) {
        await this.insertOpsBatch(newId, contentOps, Date.now());
      }

      // Announce the new page to the target space and hand peers its content so
      // it isn't blank until a full re-sync.
      await this.emitSpaceOp(input.spaceId, {
        op: "page_add",
        pageId: newId,
        parentId: input.parentId,
        order,
        task: s.task === 1,
        color: s.color ?? undefined,
        scheduledAt: s.scheduled_at ?? null,
        duration: s.duration ?? null,
        allDay: s.all_day === null ? null : s.all_day === 1,
      });
      if (contentOps.length > 0) {
        this.replicator?.pushPageOps(input.spaceId, newId, contentOps);
      }
      this.notifySpaceChange(input.spaceId);

      return newId;
    },

    reorder: async (id: string, order: number): Promise<void> => {
      await this.driver.db.mutate(
        'UPDATE pages SET "order" = ?, updated_at = ? WHERE id = ?',
        [order, new Date().toISOString(), id],
      );

      const spaceId = await this.getPageSpaceId(id);
      if (spaceId) {
        await this.emitSpaceOp(spaceId, {
          op: "page_set",
          pageId: id,
          field: "order",
          value: order,
        });
        this.notifySpaceChange(spaceId);
      }
    },

    search: async (
      spaceId: string,
      query: string,
    ): Promise<PageSearchResult[]> => {
      const rows = await this.driver.db.query<{
        id: string;
        title: string | null;
        title_md: string | null;
        body_text: string | null;
        parent_id: string | null;
        color: string | null;
      }>(
        "SELECT id, title, title_md, body_text, parent_id, color FROM pages WHERE space_id = ? AND (title LIKE ? OR body_text LIKE ?) AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 20",
        [spaceId, `%${query}%`, `%${query}%`],
      );

      const results: PageSearchResult[] = [];
      for (const r of rows) {
        const path = await this.buildParentChain(r.parent_id);
        results.push({
          id: r.id,
          title: r.title,
          titleMd: r.title_md,
          parentId: r.parent_id,
          path,
          color: r.color,
          snippet: bodySnippet(r.body_text, query),
        });
      }
      return results;
    },

    calendar: async (
      start: number,
      end: number,
    ): Promise<PageCalendarItem[]> => {
      const rows = await this.driver.db.query<{
        id: string;
        title: string;
        title_md: string;
        parent_id: string | null;
        order: number;
        color: string | null;
        scheduled_at: string;
        duration: number | null;
        all_day: number | null;
        recurrence_id: string | null;
        task: number;
        created_at: string;
      }>(
        `SELECT * FROM pages
         WHERE scheduled_at IS NOT NULL AND archived_at IS NULL
         AND scheduled_at >= ? AND scheduled_at <= ?
         ORDER BY scheduled_at ASC`,
        [new Date(start).toISOString(), new Date(end).toISOString()],
      );

      const results: PageCalendarItem[] = [];
      for (const r of rows) {
        const path = await this.buildParentChain(r.parent_id);
        results.push({
          id: r.id,
          title: r.title,
          titleMd: r.title_md,
          parentId: r.parent_id,
          order: r.order,
          color: r.color,
          scheduledAt: r.scheduled_at,
          duration: r.duration,
          allDay: r.all_day === null ? null : r.all_day === 1,
          recurrenceId: r.recurrence_id,
          task: r.task === 1,
          path,
          createdAt: r.created_at,
        });
      }
      return results;
    },

    snapshots: async (pageId: string): Promise<PageSnapshot[]> => {
      const rows = await this.driver.db.query<{
        data: Uint8Array;
        timestamp: number;
      }>(
        "SELECT data, timestamp FROM ops WHERE scope_id = ? ORDER BY clock, peer_id",
        [pageId],
      );
      if (rows.length === 0) return [];

      type ParsedRow = {
        op: import("@tasfer/editor/state-types").Operation;
        timestamp: number;
      };
      const parsed: ParsedRow[] = [];
      for (const r of rows) {
        try {
          parsed.push({
            op: JSON.parse(new TextDecoder().decode(r.data as Uint8Array)),
            timestamp: r.timestamp,
          });
        } catch {
          /* skip corrupted */
        }
      }
      if (parsed.length === 0) return [];

      // Pick evenly-spaced sample points
      const MAX_VERSIONS = 25;
      const total = parsed.length;
      const step = Math.max(1, Math.floor(total / MAX_VERSIONS));
      const sampleIndices = new Set<number>();
      for (let i = step - 1; i < total; i += step) sampleIndices.add(i);
      sampleIndices.add(total - 1);

      // Apply ops incrementally, snapshot at sample points.
      // Defers text_delete ops whose referenced chars haven't been inserted
      // yet (HLC order ≠ causal order).
      const { applyOp, createEmptyPageState } =
        await import("@tasfer/editor/sync/reducer");

      let state = createEmptyPageState(pageId);
      const insertedCharIds = new Set<string>();
      const deferredOps: import("@tasfer/editor/state-types").Operation[] =
        [];
      const results: PageSnapshot[] = [];

      for (let i = 0; i < total; i++) {
        const { op, timestamp } = parsed[i];

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
          deferredOps.push(op);
        } else {
          state = applyOp(state, op, appDataSchema);
        }

        if (sampleIndices.has(i)) {
          let snapshotState = state;
          for (const deferred of deferredOps) {
            snapshotState = applyOp(snapshotState, deferred, appDataSchema);
          }
          results.push({
            id: `${op.clock.counter}-${op.clock.peerId}`,
            pageId,
            blocks: sortBlocksByOrder(snapshotState.blocks),
            clock: op.clock,
            opCount: i + 1,
            createdAt: timestamp || 0,
          });
        }
      }

      return results.reverse();
    },

    onDeleted: (cb: (pageId: string) => void): (() => void) => {
      this.pageDeleteListeners.add(cb);
      return () => {
        this.pageDeleteListeners.delete(cb);
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------------

  private blobUrlCache = new Map<string, string>();

  private createBlobUrl(data: Uint8Array, mimeType?: string): string {
    const blob = new Blob([data as BlobPart], {
      type: mimeType || "application/octet-stream",
    });
    return URL.createObjectURL(blob);
  }

  private guessMimeType(fileName: string): string {
    const ext = fileName.split(".").pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      bmp: "image/bmp",
      ico: "image/x-icon",
    };
    return mimeTypes[ext || ""] || "application/octet-stream";
  }

  assets = {
    store: async (file: File): Promise<Asset> => {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const hash = await hashBytes(buffer);
      const ext = file.name.split(".").pop() || "bin";
      const path = `${this.driver.basePath}/assets/${assetFileName(hash, ext)}`;

      if (!(await this.driver.fs.exists(path))) {
        await this.driver.fs.write(path, buffer);
      }

      if (!this.blobUrlCache.has(hash)) {
        this.blobUrlCache.set(hash, this.createBlobUrl(buffer, file.type));
      }

      return {
        hash,
        fileName: file.name,
        mimeType: file.type,
        size: buffer.length,
      };
    },

    getUrl: async (hash: string): Promise<string> => {
      if (this.blobUrlCache.has(hash)) {
        return this.blobUrlCache.get(hash)!;
      }

      const assetsDir = `${this.driver.basePath}/assets`;
      let files = await this.driver.fs.list(assetsDir);
      let match = files.find((f) => f.startsWith(hash));

      // Not found locally — try requesting from connected peers
      if (!match && this.replicator) {
        const found = await this.replicator.requestAsset(hash);
        if (found) {
          files = await this.driver.fs.list(assetsDir);
          match = files.find((f) => f.startsWith(hash));
        }
      }

      if (!match) {
        throw new Error(`Asset not found: ${hash}`);
      }

      const data = await this.driver.fs.read(`${assetsDir}/${match}`);
      if (!data) {
        throw new Error(`Asset file unreadable: ${match}`);
      }

      const blobUrl = this.createBlobUrl(data, this.guessMimeType(match));
      this.blobUrlCache.set(hash, blobUrl);
      return blobUrl;
    },

    /**
     * Fetch raw asset bytes + mime. Used over the RPC seam when the engine runs
     * in the worker: a `blob:` URL minted there is dead in the tab DOM, so the
     * client mints its own URL from these bytes. Same lookup as `getUrl`,
     * including the peer-request fallback, but context-free.
     */
    getBytes: async (
      hash: string,
    ): Promise<{ data: Uint8Array; mime: string } | null> => {
      const assetsDir = `${this.driver.basePath}/assets`;
      let files = await this.driver.fs.list(assetsDir);
      let match = files.find((f) => f.startsWith(hash));

      if (!match && this.replicator) {
        const found = await this.replicator.requestAsset(hash);
        if (found) {
          files = await this.driver.fs.list(assetsDir);
          match = files.find((f) => f.startsWith(hash));
        }
      }

      if (!match) return null;
      const data = await this.driver.fs.read(`${assetsDir}/${match}`);
      if (!data) return null;
      return { data, mime: this.guessMimeType(match) };
    },

    delete: async (hash: string): Promise<void> => {
      const cachedUrl = this.blobUrlCache.get(hash);
      if (cachedUrl) {
        URL.revokeObjectURL(cachedUrl);
        this.blobUrlCache.delete(hash);
      }

      const files = await this.driver.fs.list(`${this.driver.basePath}/assets`);
      for (const file of files) {
        if (file.startsWith(hash)) {
          await this.driver.fs.delete(`${this.driver.basePath}/assets/${file}`);
        }
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Sync — platform-specific, must be provided
  // ---------------------------------------------------------------------------

  sync: Platform["sync"] = {
    async joinRoom() {
      invariant(false, "Sync not initialized");
    },
    async leaveRoom() {
      invariant(false, "Sync not initialized");
    },
    sendOperations() {
      invariant(false, "Sync not initialized");
    },
    sendSyncRequest() {
      invariant(false, "Sync not initialized");
    },
    sendSyncResponse() {
      invariant(false, "Sync not initialized");
    },
    sendAwareness() {
      invariant(false, "Sync not initialized");
    },
    onPageEvents() {
      return () => {};
    },
    getConnectionState() {
      return "disconnected" as const;
    },
    onConnectionChange() {
      return () => {};
    },
    getConnectedPeers() {
      return [];
    },
    onConnectedPeersChange() {
      return () => {};
    },
    onPeerVersionMismatch() {
      return () => {};
    },
  };

  /** Replace the sync implementation (called by platform init) */
  setSync(sync: Platform["sync"]): void {
    this.sync = sync;
  }

  // ---------------------------------------------------------------------------
  // Ops (CRDT operation persistence)
  // ---------------------------------------------------------------------------

  /** Batch-insert ops using multi-row INSERT to minimise IPC round-trips on iOS. */
  private async insertOpsBatch(
    pageId: string,
    operations: import("@tasfer/editor/state-types").Operation[],
    now: number,
  ): Promise<void> {
    if (operations.length === 0) return;
    // SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999; each row uses 6 params.
    // Chunk at 100 rows (600 params) to stay well within every platform's limit.
    const CHUNK = 100;
    for (let i = 0; i < operations.length; i += CHUNK) {
      const chunk = operations.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      const params: unknown[] = [];
      for (const op of chunk) {
        params.push(
          pageId,
          op.clock.peerId,
          op.clock.counter,
          op.op,
          new TextEncoder().encode(JSON.stringify(op)),
          now,
        );
      }
      await this.driver.db.mutate(
        `INSERT OR IGNORE INTO ops (scope_id, peer_id, clock, type, data, timestamp) VALUES ${placeholders}`,
        params,
      );
    }
  }

  ops = {
    persist: async (
      pageId: string,
      operations: import("@tasfer/editor/state-types").Operation[],
    ): Promise<void> => {
      await this.insertOpsBatch(pageId, operations, Date.now());
      // The doc ops just changed and they — not any denormalized metadata — are
      // the source of truth for the page's title columns. Re-derive them, the
      // same as the remote path (handleRemotePageOps). The body editor's
      // app-layer save only fires for edits it sees as local and only when the
      // VISIBLE title text changes, so it misses two cases this covers: edits
      // made through a secondary surface (a TitleEditor windows the shared doc,
      // so the body sees them as remote) and marks-only heading edits (wrapping
      // a run as inline math changes title_md's `$…$` projection but not the
      // plain title). Debounced + no-op-guarded in scheduleTitleRefresh.
      this.scheduleTitleRefresh(pageId);
    },

    /** Convert blocks to CRDT ops and persist them (used by import) */
    writeBlocks: async (
      pageId: string,
      blocks: import("@tasfer/editor/serlization/loadPage").Block[],
    ): Promise<void> => {
      const { blocksToOps } =
        await import("@tasfer/editor/sync/snapshot-diff");
      const { createIdGenerator, generatePeerId } =
        await import("@tasfer/editor/sync/id");
      const { createHLC, tickHLC } = await import("@tasfer/editor/sync/hlc");

      const peerId = generatePeerId();
      const nextId = createIdGenerator(peerId);
      let hlc = createHLC(peerId);
      const getClock = () => {
        hlc = tickHLC(hlc);
        return hlc;
      };

      const ops = blocksToOps(blocks, {
        pageId,
        peerId,
        nextId,
        getClock,
        schema: appDataSchema,
        existingFirstBlockId: `__init_block__:${pageId}`,
      });
      await this.ops.persist(pageId, ops);

      // Broadcast to connected peers so they get the content immediately
      if (this.replicator && ops.length > 0) {
        const spaceId = await this.getPageSpaceId(pageId);
        if (spaceId) {
          this.replicator.pushPageOps(spaceId, pageId, ops);
        }
      }
    },

    load: async (
      pageId: string,
    ): Promise<import("@tasfer/editor/state-types").Operation[]> => {
      const rows = await this.driver.db.query<{ data: Uint8Array }>(
        "SELECT data FROM ops WHERE scope_id = ? ORDER BY clock, peer_id",
        [pageId],
      );
      const ops: import("@tasfer/editor/state-types").Operation[] = [];
      for (const r of rows) {
        try {
          ops.push(JSON.parse(new TextDecoder().decode(r.data as Uint8Array)));
        } catch {
          /* skip corrupted ops */
        }
      }
      return ops;
    },
  };

  // ---------------------------------------------------------------------------
  // Filesystem snapshots — fast page-open path for large op logs
  // ---------------------------------------------------------------------------

  private snapshotPath(pageId: string): string {
    return `${this.driver.basePath}/snapshots/${pageId}.json`;
  }

  snapshots = {
    save: async (
      pageId: string,
      blocks: import("@tasfer/editor/serlization/loadPage").Block[],
      vv: Record<string, number>,
    ): Promise<void> => {
      try {
        // `vv` is supplied by the caller and describes the exact op set these
        // blocks reflect — it is NOT re-derived from the ops table here, because
        // a frontier read at this instant can include ops not yet folded into
        // `blocks` (e.g. a remote op persisted but not yet applied to the doc).
        // Strip ephemeral render cache before persisting — cachedLayout is a
        // large, per-canvas-width measured-layout object, invalid across sessions
        // and screen sizes.
        const cleanBlocks = blocks.map(({ cachedLayout: _l, ...b }) => b);
        const data = new TextEncoder().encode(
          JSON.stringify({ format: PAGE_SNAPSHOT_FORMAT, vv, blocks: cleanBlocks }),
        );
        await this.driver.fs.write(this.snapshotPath(pageId), data);
      } catch (err) {
        console.warn("[Engine] Failed to save snapshot:", err);
      }
    },
  };

  private async loadSnapshot(pageId: string): Promise<{
    vv: Record<string, number>;
    blocks: import("@tasfer/editor/serlization/loadPage").Block[];
  } | null> {
    try {
      const data = await this.driver.fs.read(this.snapshotPath(pageId));
      if (!data) return null;
      const parsed = JSON.parse(new TextDecoder().decode(data));
      // Snapshots written before the vv-token format (or otherwise malformed)
      // lack `vv`; treat them as untrusted so the caller replays the log and
      // rewrites a well-formed snapshot.
      if (
        !parsed ||
        parsed.format !== PAGE_SNAPSHOT_FORMAT ||
        typeof parsed.vv !== "object" ||
        parsed.vv === null
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * The clock-based version vector (`{ [clockPeerId]: maxClockCounter }`) of a
   * page's op log, read straight from the indexed `ops` columns without
   * deserializing op bodies. This is the same frontier the sync layer compares
   * against, and the token a filesystem snapshot is validated by.
   */
  private async pageClockVV(pageId: string): Promise<Record<string, number>> {
    const rows = await this.driver.db.query<{
      peer_id: string;
      max_clock: number;
    }>(
      "SELECT peer_id, MAX(clock) as max_clock FROM ops WHERE scope_id = ? GROUP BY peer_id",
      [pageId],
    );
    const vv: Record<string, number> = {};
    for (const row of rows) vv[row.peer_id] = row.max_clock;
    return vv;
  }

  // ---------------------------------------------------------------------------
  // Space CRDT: Remote ops handling (called by sync layer)
  // ---------------------------------------------------------------------------

  /** Apply remote space operations received from a peer */
  async handleRemoteSpaceOps(
    spaceId: string,
    ops: SpaceOperation[],
  ): Promise<void> {
    const avatarRefs: string[] = [];
    let certsArrived = false;
    for (const op of ops) {
      await this.storeSpaceOp(op);
      await this.applySpaceOp(op);

      // A member_add in a space we belong to is how we learn about a co-member
      // nobody introduced us to. Connect to them directly rather than routing
      // through whoever added them; addPeer re-checks membership itself, so a
      // key named in a space we are not in gets nowhere.
      if (op.op === "member_add" && this.replicator) {
        const identity = await this.identity.get();
        if (op.publicKey !== identity.publicKey) {
          void this.replicator.addPeer(op.publicKey).catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(
              `[Engine] failed to connect to new member ${op.publicKey.slice(0, 8)}: ${msg}`,
            );
          });
        }
      }

      // A certificate can arrive after the member_add it vouches for — the
      // addPeer above would have refused that key while the space was personal
      // and the device unknown. Admission is a read-time join, so re-running
      // the reconciler is all that is needed to pick the member up.
      if (op.op === "device_add" && this.replicator) {
        certsArrived = true;
      }

      if (
        op.op === "member_set" &&
        op.field === "avatar" &&
        typeof op.value === "string"
      ) {
        avatarRefs.push(op.value);
      }
    }
    if (certsArrived) {
      await this.replicator?.refreshSpaces().catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Engine] refreshSpaces after device_add failed: ${msg}`);
      });
    }
    this.assetPrefetcher.noteRefs(avatarRefs);
    this.notifySpaceChange(spaceId);
  }

  /** Apply remote page content operations received from a peer */
  async handleRemotePageOps(
    pageId: string,
    ops: import("@tasfer/editor/state-types").Operation[],
  ): Promise<void> {
    await this.insertOpsBatch(pageId, ops, Date.now());
    // The doc ops just changed and they — not any replicated metadata — are
    // the source of truth for the page's title columns. Re-derive them.
    this.scheduleTitleRefresh(pageId);
  }

  // ---------------------------------------------------------------------------
  // Derived titles — pages.title / pages.title_md are LOCAL caches of the doc
  // ---------------------------------------------------------------------------

  /** Per-page debounce timers for {@link scheduleTitleRefresh}. */
  private titleRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Re-derive the title columns for a page whose content ops changed, after a
   * short per-page debounce. Remote edits stream in as many small batches
   * (one per broadcast), and each refresh replays the page's op log — the
   * debounce collapses a typing burst into one rebuild.
   */
  private scheduleTitleRefresh(pageId: string): void {
    const pending = this.titleRefreshTimers.get(pageId);
    if (pending) clearTimeout(pending);
    this.titleRefreshTimers.set(
      pageId,
      setTimeout(() => {
        this.titleRefreshTimers.delete(pageId);
        this.rebuildBlocksFromOps(pageId)
          .then((rebuilt) => {
            if (rebuilt) {
              // Blocks in hand — pull any assets the changed doc references
              // before anyone opens the page.
              this.assetPrefetcher.noteRefs(
                collectAssetRefs(rebuilt.blocks, appDataSchema),
              );
              return this.refreshDerivedTitlesFromBlocks(pageId, rebuilt.blocks);
            }
          })
          .catch((err) =>
            console.warn("[Engine] Failed to refresh derived titles:", err),
          );
      }, 1000),
    );
  }

  /**
   * Update the derived title columns from blocks the caller already has (no
   * op-log replay), notifying space listeners only when something actually
   * changed. This is the single writer that keeps `pages.title`/`title_md`
   * mirroring the doc — the doc's operation log stays the source of truth,
   * and these columns are just a rebuildable index over it for list views.
   */
  private async refreshDerivedTitlesFromBlocks(
    pageId: string,
    blocks: import("@tasfer/editor/serlization/loadPage").Block[],
  ): Promise<void> {
    const { title, titleMd } = deriveTitles(blocks);
    const bodyText = extractBodyText(blocks);
    const rows = await this.driver.db.query<{
      title: string;
      title_md: string;
      body_text: string | null;
      space_id: string | null;
    }>(
      "SELECT title, title_md, body_text, space_id FROM pages WHERE id = ?",
      [pageId],
    );
    if (rows.length === 0) return;
    const titleChanged =
      rows[0].title !== title || rows[0].title_md !== titleMd;
    const bodyChanged = rows[0].body_text !== bodyText;
    if (!titleChanged && !bodyChanged) return;

    await this.driver.db.mutate(
      "UPDATE pages SET title = ?, title_md = ?, body_text = ?, updated_at = ? WHERE id = ?",
      [title, titleMd, bodyText, new Date().toISOString(), pageId],
    );
    // Only the title columns are list-visible, so a body-only change (typing in
    // the document) refreshes the search index without churning the sidebar.
    if (titleChanged && rows[0].space_id)
      this.notifySpaceChange(rows[0].space_id);
  }

  /**
   * One-time (per page) backfill of pages.body_text for the local search index.
   * body_text is NULL on rows that predate the column, so rebuild each such
   * page's blocks from its op log and derive the text. Runs in the background
   * off init so it never blocks startup, and is naturally idempotent: only NULL
   * rows are touched, and pages with no content ops get '' so an empty page is
   * not rescanned every boot. Existing title columns are unaffected — the write
   * only fires when a derived value actually differs.
   */
  private async backfillBodyText(): Promise<void> {
    const rows = await this.driver.db.query<{ id: string }>(
      "SELECT id FROM pages WHERE body_text IS NULL",
    );
    for (const { id } of rows) {
      try {
        const rebuilt = await this.rebuildBlocksFromOps(id);
        if (rebuilt) {
          await this.refreshDerivedTitlesFromBlocks(id, rebuilt.blocks);
        }
        // rebuildBlocksFromOps returns null for a page with no content ops;
        // refreshDerivedTitlesFromBlocks leaves body_text NULL when it writes
        // an empty page, so pin the NULL rows that remain to '' — this is the
        // one place that distinction is resolved, keeping backfill idempotent.
        await this.driver.db.mutate(
          "UPDATE pages SET body_text = '' WHERE id = ? AND body_text IS NULL",
          [id],
        );
      } catch (err) {
        console.warn("[Engine] body_text backfill failed for", id, err);
      }
    }
  }

  /**
   * Seed the asset prefetcher with every reference reachable from local data:
   * all pages' blocks (archived included — they can be restored) plus member
   * avatars. Runs once per boot in the background, so assets referenced by
   * pages that synced while their holder was only briefly online — or before
   * eager prefetch existed — are pulled without anyone opening the page.
   * Uses the page snapshot when it is current and replays the op log
   * otherwise, the same fast/slow split as pages.get.
   */
  private async sweepAssetRefs(): Promise<void> {
    const members = await this.driver.db.query<{ avatar: string }>(
      "SELECT DISTINCT avatar FROM space_members WHERE avatar IS NOT NULL",
    );
    this.assetPrefetcher.noteRefs(members.map((m) => m.avatar));

    const pages = await this.driver.db.query<{ id: string }>(
      "SELECT id FROM pages",
    );
    for (const { id } of pages) {
      try {
        const currentVV = await this.pageClockVV(id);
        const cached = await this.loadSnapshot(id);
        let blocks =
          cached && vvEqual(cached.vv, currentVV) ? cached.blocks : null;
        if (!blocks) {
          const rebuilt = await this.rebuildBlocksFromOps(id);
          if (rebuilt) {
            blocks = rebuilt.blocks;
            // Persist the rebuilt snapshot so the next boot's sweep (and the
            // next page open) take the fast path.
            this.snapshots.save(id, blocks, rebuilt.vv).catch(() => {});
          }
        }
        if (blocks) {
          this.assetPrefetcher.noteRefs(
            collectAssetRefs(blocks, appDataSchema),
          );
        }
      } catch (err) {
        console.warn("[Engine] asset sweep failed for page", id, err);
      }
    }
  }

  /** Build a sync response for a requesting peer */
  async buildSpaceSyncResponse(
    spaceId: string,
    remoteSpaceVV: Record<string, number>,
    remotePageVVs: Record<string, Record<string, number>>,
  ): Promise<{
    spaceOps: SpaceOperation[];
    pageOps: Record<
      string,
      import("@tasfer/editor/state-types").Operation[]
    >;
  }> {
    // Get missing space ops
    const allSpaceOps = await this.getSpaceOps(spaceId);
    const missingSpaceOps = allSpaceOps.filter((op) => {
      const known = remoteSpaceVV[op.clock.peerId] ?? -1;
      return op.clock.counter > known;
    });

    // Get all local page VVs in one query, then only fetch ops for pages
    // where we have something the remote hasn't seen.
    const localVVRows = await this.driver.db.query<{
      page_id: string;
      peer_id: string;
      max_clock: number;
    }>(
      `SELECT o.scope_id as page_id, o.peer_id, MAX(o.clock) as max_clock
       FROM ops o
       INNER JOIN pages p ON p.id = o.scope_id
       WHERE p.space_id = ?
       GROUP BY o.scope_id, o.peer_id`,
      [spaceId],
    );

    const localPageVVs: Record<string, Record<string, number>> = {};
    for (const row of localVVRows) {
      if (!localPageVVs[row.page_id]) localPageVVs[row.page_id] = {};
      localPageVVs[row.page_id][row.peer_id] = row.max_clock;
    }

    const pageOps: Record<
      string,
      import("@tasfer/editor/state-types").Operation[]
    > = {};
    for (const [pageId, localVV] of Object.entries(localPageVVs)) {
      const remoteVV = remotePageVVs[pageId] ?? {};

      // Skip this page if the remote already has everything we have
      const hasMissing = Object.entries(localVV).some(
        ([peerId, maxClock]) => maxClock > (remoteVV[peerId] ?? -1),
      );
      if (!hasMissing) continue;

      const rows = await this.driver.db.query<{
        data: Uint8Array;
        peer_id: string;
        clock: number;
      }>(
        "SELECT data, peer_id, clock FROM ops WHERE scope_id = ? ORDER BY clock",
        [pageId],
      );

      const missing: import("@tasfer/editor/state-types").Operation[] = [];
      for (const row of rows) {
        const known = remoteVV[row.peer_id] ?? -1;
        if (row.clock > known) {
          try {
            missing.push(
              JSON.parse(new TextDecoder().decode(row.data as Uint8Array)),
            );
          } catch {
            /* skip corrupted ops */
          }
        }
      }
      if (missing.length > 0) {
        pageOps[pageId] = missing;
      }
    }

    return { spaceOps: missingSpaceOps, pageOps };
  }

  /** Build a per-page sync response: return ops the requester is missing + local VV */
  async buildPageSyncResponse(
    pageId: string,
    remoteVV: Record<string, number>,
  ): Promise<{
    ops: import("@tasfer/editor/state-types").Operation[];
    versionVector: Record<string, number>;
  }> {
    const rows = await this.driver.db.query<{
      data: Uint8Array;
      peer_id: string;
      clock: number;
    }>(
      "SELECT data, peer_id, clock FROM ops WHERE scope_id = ? ORDER BY clock",
      [pageId],
    );

    const missing: import("@tasfer/editor/state-types").Operation[] = [];
    const localVV: Record<string, number> = {};
    for (const row of rows) {
      // Build local VV
      if (
        localVV[row.peer_id] === undefined ||
        row.clock > localVV[row.peer_id]
      ) {
        localVV[row.peer_id] = row.clock;
      }
      // Collect missing ops
      const known = remoteVV[row.peer_id] ?? -1;
      if (row.clock > known) {
        try {
          missing.push(
            JSON.parse(new TextDecoder().decode(row.data as Uint8Array)),
          );
        } catch {
          /* skip corrupted */
        }
      }
    }
    return { ops: missing, versionVector: localVV };
  }

  /** Get the space version vector (for sync requests) */
  async getSpaceVV(spaceId: string): Promise<Record<string, number>> {
    const scopeId = `space:${spaceId}`;
    const rows = await this.driver.db.query<{
      peer_id: string;
      max_clock: number;
    }>(
      "SELECT peer_id, MAX(clock) as max_clock FROM ops WHERE scope_id = ? GROUP BY peer_id",
      [scopeId],
    );
    const vv: Record<string, number> = {};
    for (const r of rows) vv[r.peer_id] = r.max_clock;
    return vv;
  }

  /** Get page version vectors for all pages in a space */
  async getPageVVs(
    spaceId: string,
  ): Promise<Record<string, Record<string, number>>> {
    const rows = await this.driver.db.query<{
      page_id: string;
      peer_id: string;
      max_clock: number;
    }>(
      `SELECT o.scope_id as page_id, o.peer_id, MAX(o.clock) as max_clock
       FROM ops o
       INNER JOIN pages p ON p.id = o.scope_id
       WHERE p.space_id = ?
       GROUP BY o.scope_id, o.peer_id`,
      [spaceId],
    );

    const result: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      if (!result[row.page_id]) result[row.page_id] = {};
      result[row.page_id][row.peer_id] = row.max_clock;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Private: Space CRDT helpers
  // ---------------------------------------------------------------------------

  private async getPrivateKey(): Promise<string> {
    const rows = await this.driver.db.query<{ private_key: string }>(
      "SELECT private_key FROM identity WHERE id = 1",
    );
    return rows[0].private_key;
  }

  private async getPageSpaceId(pageId: string): Promise<string | null> {
    const rows = await this.driver.db.query<{ space_id: string | null }>(
      "SELECT space_id FROM pages WHERE id = ?",
      [pageId],
    );
    return rows[0]?.space_id ?? null;
  }

  private nextSpaceHlcCounter(spaceId: string): number {
    const current = this.spaceHlcCounters.get(spaceId) ?? 0;
    const next = current + 1;
    this.spaceHlcCounters.set(spaceId, next);
    return next;
  }

  private async emitSpaceOp(
    spaceId: string,
    partial: Record<string, unknown> & { op: string },
  ): Promise<void> {
    const identity = await this.identity.get();
    const counter = this.nextSpaceHlcCounter(spaceId);
    const clock: HLC = { counter, peerId: identity.publicKey };
    const id = `${identity.publicKey}:${counter}`;

    const op = { ...partial, id, clock, spaceId } as SpaceOperation;
    await this.storeSpaceOp(op);

    // When we locally add a member, recompute shared spaces so
    // broadcastToSpacePeers can reach them for this space.
    if (op.op === "member_add" && this.replicator) {
      if (op.publicKey !== identity.publicKey) {
        await this.replicator.addPeer(op.publicKey);
      }
    }

    // Broadcast to peers
    if (this.replicator) {
      this.replicator.pushSpaceOps(spaceId, [op]);
    }
  }

  private async storeSpaceOp(op: SpaceOperation): Promise<void> {
    const scopeId = `space:${op.spaceId}`;
    const data = new TextEncoder().encode(JSON.stringify(op));
    // device_add names its subject in `deviceKey` rather than `publicKey`, so
    // index it the same way — enrollOwnDevices looks certificates up by it.
    const targetKey =
      (op as { publicKey?: string }).publicKey ??
      (op as { deviceKey?: string }).deviceKey ??
      null;
    await this.driver.db.mutate(
      "INSERT OR IGNORE INTO ops (scope_id, peer_id, clock, type, data, timestamp, target_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        scopeId,
        op.clock.peerId,
        op.clock.counter,
        op.op,
        data,
        Date.now(),
        targetKey,
      ],
    );

    // Update local HLC counter
    const current = this.spaceHlcCounters.get(op.spaceId) ?? 0;
    if (op.clock.counter > current) {
      this.spaceHlcCounters.set(op.spaceId, op.clock.counter);
    }
  }

  private async getSpaceOps(spaceId: string): Promise<SpaceOperation[]> {
    const scopeId = `space:${spaceId}`;
    const rows = await this.driver.db.query<{ data: Uint8Array }>(
      "SELECT data FROM ops WHERE scope_id = ? ORDER BY clock, peer_id",
      [scopeId],
    );
    const ops: SpaceOperation[] = [];
    for (const r of rows) {
      try {
        ops.push(JSON.parse(new TextDecoder().decode(r.data as Uint8Array)));
      } catch {
        /* skip corrupted */
      }
    }
    return ops;
  }

  /**
   * Check if an op's HLC wins for the given (spaceId, entity, field) slot.
   * If it wins (or is the first op for this slot), update the winner and return true.
   */
  private lwwCheck(
    spaceId: string,
    entity: string,
    field: string,
    clock: HLC,
  ): boolean {
    const key = `${spaceId}\0${entity}\0${field}`;
    const current = this.spaceLwwWinners.get(key);
    if (current) {
      // Incoming must be strictly greater to win
      if (
        clock.counter < current.counter ||
        (clock.counter === current.counter && clock.peerId <= current.peerId)
      ) {
        return false;
      }
    }
    this.spaceLwwWinners.set(key, {
      counter: clock.counter,
      peerId: clock.peerId,
    });
    return true;
  }

  private async applySpaceOp(op: SpaceOperation): Promise<void> {
    const now = new Date().toISOString();
    switch (op.op) {
      case "space_set":
        // `personal` is monotonic rather than LWW: it is set once, at creation,
        // and no op ever clears it. Resolving it last-writer-wins would let a
        // later-clocked op turn it off, which is the one thing the flag exists
        // to rule out. Upsert, since it can arrive before the name op for a
        // space this replica has never seen.
        if (op.field === "personal") {
          if (op.value === true) {
            await this.driver.db.mutate(
              `INSERT INTO spaces (id, created_at, personal) VALUES (?, ?, 1)
               ON CONFLICT(id) DO UPDATE SET personal = 1`,
              [op.spaceId, now],
            );
          }
          break;
        }
        if (!this.lwwCheck(op.spaceId, "space", op.field, op.clock)) break;
        if (op.field === "name") {
          // Upsert so the space row is created when receiving ops for a space
          // we don't yet have locally (bootstrapping from a remote peer).
          await this.driver.db.mutate(
            `INSERT INTO spaces (id, name, created_at) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = ?`,
            [op.spaceId, op.value, now, op.value],
          );
        }
        break;

      case "member_add": {
        await this.driver.db.mutate(
          `INSERT INTO space_members (space_id, public_key, name, added_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(space_id, public_key) DO UPDATE SET name = ?`,
          [op.spaceId, op.publicKey, op.name, now, op.name],
        );
        // Record the peer so it has a name to display. Membership is what
        // admits it to sync (see Replicator.admittedPeers), so this must not
        // re-raise `trusted` on conflict: a peer the local user revoked would
        // otherwise be readmitted by the next member_add naming it.
        await this.driver.db.mutate(
          `INSERT INTO peers (public_key, name, trusted) VALUES (?, ?, 1)
           ON CONFLICT(public_key) DO UPDATE SET name = COALESCE(?, name)`,
          [op.publicKey, op.name, op.name],
        );
        break;
      }

      case "device_add": {
        // Verify before caching. An unverifiable certificate is dropped from
        // the PROJECTION only — storeSpaceOp has already persisted the op, so
        // it still relays to other peers, who reach the same verdict
        // independently. Nothing here filters the log.
        const valid = await verifyDeviceCert(this.driver.crypto, {
          rootKey: op.rootKey,
          deviceKey: op.deviceKey,
          cert: op.cert,
          issuedAt: op.issuedAt,
        });
        if (!valid) {
          console.warn(
            `[Engine] rejected device cert for ${op.deviceKey.slice(0, 8)} under root ${op.rootKey.slice(0, 8)}: signature does not verify`,
          );
          break;
        }
        await this.storeDeviceCert({
          rootKey: op.rootKey,
          deviceKey: op.deviceKey,
          cert: op.cert,
          issuedAt: op.issuedAt,
        });
        // A personal space's membership is a read-time join against `devices`
        // (see queryVisibleMembers), so a certificate arriving after the
        // member_add it vouches for promotes that member with no replay. This
        // notify is what tells the transport to re-evaluate admission.
        break;
      }

      case "member_set": {
        if (
          !this.lwwCheck(
            op.spaceId,
            `member:${op.publicKey}`,
            op.field,
            op.clock,
          )
        )
          break;
        const memberFieldMap: Record<string, string> = {
          name: "name",
          avatar: "avatar",
        };
        const memberCol = memberFieldMap[op.field];
        if (memberCol) {
          await this.driver.db.mutate(
            `UPDATE space_members SET ${memberCol} = ? WHERE space_id = ? AND public_key = ? AND archived_at IS NULL`,
            [op.value, op.spaceId, op.publicKey],
          );
        }
        // Also update peer name if that's what changed
        if (op.field === "name") {
          await this.driver.db.mutate(
            "UPDATE peers SET name = ? WHERE public_key = ?",
            [op.value, op.publicKey],
          );
        }
        break;
      }

      case "page_add": {
        if (!this.lwwCheck(op.spaceId, `page:${op.pageId}`, "_alive", op.clock))
          break;
        const exists = await this.driver.db.query(
          "SELECT archived_at FROM pages WHERE id = ?",
          [op.pageId],
        );
        if (exists.length === 0) {
          // Title columns start empty ('' defaults) — they are derived locally
          // from the page's content ops as they arrive (refreshDerivedTitles).
          await this.driver.db.mutate(
            `INSERT INTO pages (id, parent_id, "order", space_id, task, color, scheduled_at, duration, all_day, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              op.pageId,
              op.parentId,
              op.order,
              op.spaceId,
              op.task ? 1 : 0,
              op.color ?? null,
              op.scheduledAt ?? null,
              op.duration ?? null,
              op.allDay !== undefined && op.allDay !== null
                ? op.allDay
                  ? 1
                  : 0
                : null,
              now,
              now,
            ],
          );
        } else if (exists[0].archived_at !== null) {
          // Un-archive: a page_add with higher HLC wins over a prior page_remove
          await this.driver.db.mutate(
            "UPDATE pages SET archived_at = NULL, updated_at = ? WHERE id = ?",
            [now, op.pageId],
          );
        }
        break;
      }

      case "page_remove":
        if (!this.lwwCheck(op.spaceId, `page:${op.pageId}`, "_alive", op.clock))
          break;
        await this.driver.db.mutate(
          "UPDATE pages SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
          [now, op.pageId],
        );
        this.notifyPageDeleted(op.pageId);
        break;

      case "page_set": {
        if (!this.lwwCheck(op.spaceId, `page:${op.pageId}`, op.field, op.clock))
          break;
        // No title fields here: titles are derived locally from doc content
        // ops, never accepted as replicated metadata (see PageAdd docs).
        const fieldMap: Record<string, string> = {
          parentId: "parent_id",
          order: '"order"',
          color: "color",
          task: "task",
          scheduledAt: "scheduled_at",
          duration: "duration",
          allDay: "all_day",
        };
        const col = fieldMap[op.field];
        if (col) {
          let val = op.value;
          if (op.field === "task") {
            val = val ? 1 : 0;
          } else if (op.field === "allDay") {
            val = val === null ? null : val ? 1 : 0;
          }
          await this.driver.db.mutate(
            `UPDATE pages SET ${col} = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL`,
            [val, now, op.pageId],
          );
        }
        break;
      }
      default: {
        // Unknown space op type (e.g. from a newer peer). storeSpaceOp has
        // already persisted it to the log + version vector, so it survives and
        // propagates to other peers untouched (forward-compat) — we simply
        // don't materialize it into space/page state we can't model, mirroring
        // how the page-level reducer no-ops unknown ops. The SpaceOperation
        // union is append-only; see /docs/internals/compatibility.
        break;
      }
    }
  }

  private notifySpaceChange(spaceId: string) {
    for (const cb of this.spaceChangeListeners) cb(spaceId);
  }

  private notifyPageDeleted(pageId: string) {
    for (const cb of this.pageDeleteListeners) cb(pageId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async buildParentChain(
    parentId: string | null,
  ): Promise<PagePathSegment[]> {
    const chain: PagePathSegment[] = [];
    const visited = new Set<string>();
    let currentId = parentId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const rows = await this.driver.db.query<{
        id: string;
        title: string;
        title_md: string;
        parent_id: string | null;
        color: string | null;
      }>(
        "SELECT id, title, title_md, parent_id, color FROM pages WHERE id = ? AND archived_at IS NULL",
        [currentId],
      );

      if (rows.length === 0) break;

      const r = rows[0];
      chain.unshift({
        id: r.id,
        title: r.title,
        titleMd: r.title_md,
        color: r.color,
      });
      currentId = r.parent_id;
    }

    return chain;
  }

  /** Load all ops for a page as parsed Operation objects */
  private async loadPageOps(
    pageId: string,
  ): Promise<import("@tasfer/editor/state-types").Operation[]> {
    const rows = await this.driver.db.query<{ data: Uint8Array }>(
      "SELECT data FROM ops WHERE scope_id = ? ORDER BY clock, peer_id",
      [pageId],
    );
    const ops: import("@tasfer/editor/state-types").Operation[] = [];
    for (const r of rows) {
      try {
        ops.push(JSON.parse(new TextDecoder().decode(r.data as Uint8Array)));
      } catch {
        /* skip corrupted */
      }
    }
    return ops;
  }

  /**
   * Rebuild a page's Block[] from persisted CRDT ops, paired with the clock
   * version vector of those exact ops so the result can be persisted as a
   * snapshot whose validity token matches its blocks.
   */
  private async rebuildBlocksFromOps(pageId: string): Promise<{
    blocks: import("@tasfer/editor/serlization/loadPage").Block[];
    vv: Record<string, number>;
  } | null> {
    const ops = await this.loadPageOps(pageId);
    if (ops.length === 0) return null;

    const { rebuildState } = await import("@tasfer/editor/sync/reducer");
    const page = rebuildState(pageId, ops, appDataSchema);
    if (page.blocks.length === 0) return null;

    const vv: Record<string, number> = {};
    for (const op of ops) {
      const peer = op.clock.peerId;
      if (op.clock.counter > (vv[peer] ?? -1)) vv[peer] = op.clock.counter;
    }
    return { blocks: page.blocks, vv };
  }
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * A short plain-text excerpt of a page body centered on the first occurrence of
 * `query`, for search-result previews. Returns null when the query is empty or
 * doesn't appear in the body (e.g. it matched only the title). Newlines are
 * flattened to spaces and elided context is marked with an ellipsis; the match
 * itself is highlighted by the caller.
 */
const SNIPPET_RADIUS = 40;
function bodySnippet(
  bodyText: string | null,
  query: string,
): string | null {
  const q = query.trim();
  if (!q || !bodyText) return null;
  const flat = bodyText.replace(/\s+/g, " ").trim();
  const idx = flat.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return null;

  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(flat.length, idx + q.length + SNIPPET_RADIUS);
  let snippet = flat.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < flat.length) snippet = snippet + "…";
  return snippet;
}

/**
 * Exact equality of two clock version vectors. A peer present in one side with
 * counter -1 (never seen) is treated as absent, so `{}` and `{ p: -1 }` compare
 * equal — though MAX(clock) never yields a sentinel in practice.
 */
function vvEqual(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((a[k] ?? -1) !== (b[k] ?? -1)) return false;
  }
  return true;
}

/**
 * Filename for an asset stored under `assets/`, as `<sha256-hex>.<ext>`.
 *
 * Both components can originate off-device: a peer supplies them in a binary
 * asset frame, and `ext` also comes from a picked file's name. This is the one
 * place the path is assembled, so it is where they are constrained — a hash
 * must be a full SHA-256 digest, and anything that is not a short alphanumeric
 * extension degrades to `bin`. Neither component can then escape `assets/`.
 */
export function assetFileName(hash: string, ext: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`Invalid asset hash: ${hash}`);
  }
  const lower = ext.toLowerCase();
  return `${hash}.${/^[a-z0-9]{1,8}$/.test(lower) ? lower : "bin"}`;
}

async function hashBytes(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    data.buffer as ArrayBuffer,
  );
  return bytesToHex(new Uint8Array(hash));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Derive a shared signaling encryption key from the pairing secret
 * and both peers' public keys. Both sides independently compute the
 * same key — used for all future signaling through Cloudflare.
 */
async function deriveSharedSignalingKey(
  secretHex: string,
  pubA: string,
  pubB: string,
): Promise<string> {
  const secret = hexToBytes(secretHex);
  const sorted = pubA < pubB ? `${pubA}:${pubB}` : `${pubB}:${pubA}`;
  const info = new TextEncoder().encode("tasfer-shared-key:" + sorted);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    secret.buffer as ArrayBuffer,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
    keyMaterial,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}
