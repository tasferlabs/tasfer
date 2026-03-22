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
  PageFull,
  PageCreateInput,
  PageUpdateInput,
  PageMoveInput,
  PageSearchResult,
  PageCalendarItem,
  PageSnapshot,
  Identity,
  Peer,
  Asset,
  Space,
  SpaceMember,
  SpaceOperation,
  SpaceInvite,
  PairCallbacks,
} from "./types";
import type { Driver, CryptoDriver } from "./driver";
import type { HLC } from "@/editor/sync/types";
import type { ReplicatorHost } from "./sync";
import { snapshotToOps } from "@/editor/sync/snapshot-to-ops";

/** Minimal interface the engine uses to push ops — avoids circular imports */
interface EngineReplicator {
  pushSpaceOps(spaceId: string, ops: SpaceOperation[]): void;
  addPeer(publicKey: string): Promise<void>;
  startPairing(opts: {
    invite: SpaceInvite;
    role: "initiator" | "acceptor";
    localPublicKey: string;
    localName: string;
    privateKey: string;
    callbacks: PairCallbacks;
  }): Promise<void>;
  cancelPairing(): Promise<void>;
}

// =============================================================================
// Schema initialization
// =============================================================================

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS identity (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    avatar     TEXT
  );

  CREATE TABLE IF NOT EXISTS peers (
    public_key TEXT PRIMARY KEY,
    name       TEXT,
    trusted    INTEGER NOT NULL DEFAULT 0,
    last_seen  INTEGER
  );

  CREATE TABLE IF NOT EXISTS spaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS space_members (
    space_id   TEXT NOT NULL,
    public_key TEXT NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    role       TEXT NOT NULL DEFAULT 'editor',
    added_at   TEXT NOT NULL,
    PRIMARY KEY (space_id, public_key)
  );

  CREATE TABLE IF NOT EXISTS pages (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT '',
    auto_title    INTEGER NOT NULL DEFAULT 1,
    parent_id     TEXT,
    "order"       REAL NOT NULL DEFAULT 0,
    space_id      TEXT,
    task          INTEGER NOT NULL DEFAULT 0,
    color         TEXT,
    scheduled_at  TEXT,
    duration      INTEGER,
    all_day       INTEGER,
    recurrence_id TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pages_space ON pages(space_id);

  CREATE TABLE IF NOT EXISTS ops (
    id        INTEGER PRIMARY KEY,
    page_id   TEXT NOT NULL,
    peer_id   TEXT NOT NULL,
    counter   INTEGER NOT NULL,
    type      TEXT NOT NULL,
    data      BLOB NOT NULL,
    timestamp INTEGER NOT NULL,
    UNIQUE(page_id, peer_id, counter)
  );

  CREATE INDEX IF NOT EXISTS idx_ops_page ON ops(page_id);

  CREATE TABLE IF NOT EXISTS snapshots (
    id             INTEGER PRIMARY KEY,
    page_id        TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    size           INTEGER NOT NULL,
    clock_counter  INTEGER NOT NULL,
    clock_peer_id  TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_page ON snapshots(page_id);

  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// =============================================================================
// Engine
// =============================================================================

export class Engine implements Platform {
  private driver: Driver;
  private replicator: EngineReplicator | null = null;
  private spaceHlcCounters = new Map<string, number>();
  private spaceChangeListeners = new Set<(spaceId: string) => void>();

  constructor(driver: Driver) {
    this.driver = driver;
  }

  /** Expose the raw DbDriver for debugging tools */
  getDb() {
    return this.driver.db;
  }

  /** Initialize the database schema. Call once at startup. */
  async init(): Promise<void> {
    await this.driver.db.exec(SCHEMA_SQL);
    await this.migrateOpsUniqueConstraint();
    await this.loadSpaceHlcCounters();
  }

  /**
   * Migrate ops table: add UNIQUE(page_id, peer_id, counter) if missing.
   * SQLite can't ALTER TABLE ADD CONSTRAINT, so we recreate the table.
   */
  private async migrateOpsUniqueConstraint(): Promise<void> {
    // Check if the unique index already exists
    const indexes = await this.driver.db.execute<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ops' AND sql LIKE '%UNIQUE%'",
    );
    if (indexes.length > 0) return;

    // Check if the table has data worth migrating
    const hasTable = await this.driver.db.execute<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='ops'",
    );
    if (hasTable.length === 0) return; // Fresh DB, CREATE TABLE will handle it

    // Recreate with UNIQUE constraint, deduplicating existing rows
    await this.driver.db.exec(`
      CREATE TABLE IF NOT EXISTS ops_new (
        id        INTEGER PRIMARY KEY,
        page_id   TEXT NOT NULL,
        peer_id   TEXT NOT NULL,
        counter   INTEGER NOT NULL,
        type      TEXT NOT NULL,
        data      BLOB NOT NULL,
        timestamp INTEGER NOT NULL,
        UNIQUE(page_id, peer_id, counter)
      );
      INSERT OR IGNORE INTO ops_new (page_id, peer_id, counter, type, data, timestamp)
        SELECT page_id, peer_id, counter, type, data, timestamp FROM ops;
      DROP TABLE ops;
      ALTER TABLE ops_new RENAME TO ops;
      CREATE INDEX IF NOT EXISTS idx_ops_page ON ops(page_id);
    `);
  }

  /** Load max HLC counters from persisted ops so we never regress after restart */
  private async loadSpaceHlcCounters(): Promise<void> {
    // Space ops are stored with page_id = 'space:{spaceId}'
    const rows = await this.driver.db.execute<{
      page_id: string;
      max_counter: number;
    }>(
      "SELECT page_id, MAX(counter) as max_counter FROM ops WHERE page_id LIKE 'space:%' GROUP BY page_id",
    );
    for (const r of rows) {
      const spaceId = r.page_id.slice(6); // strip 'space:' prefix
      this.spaceHlcCounters.set(spaceId, r.max_counter);
    }
  }

  /** Set the replicator instance for space sync + pairing */
  setReplicator(repl: EngineReplicator): void {
    this.replicator = repl;
  }

  // ---------------------------------------------------------------------------
  // ReplicatorHost implementation
  // ---------------------------------------------------------------------------

  /** Build a ReplicatorHost adapter for this engine */
  asReplicatorHost(): ReplicatorHost {
    return {
      getIdentity: () => this.identity.get(),
      getPrivateKey: () => this.getPrivateKey(),
      getCrypto: (): CryptoDriver => this.driver.crypto,
      getTrustedPeers: () => this.peers.list(),
      getSpaceIds: async () => {
        const spaces = await this.spaces.list();
        return spaces.map(s => s.id);
      },
      getSpaceMembers: async (spaceId: string) => {
        const space = await this.spaces.get(spaceId);
        return space.members.map(m => ({ publicKey: m.publicKey }));
      },
      getSpaceVV: (spaceId: string) => this.getSpaceVV(spaceId),
      getPageVVs: (spaceId: string) => this.getPageVVs(spaceId),
      buildSyncResponse: (spaceId, spaceVV, pageVVs) =>
        this.buildSpaceSyncResponse(spaceId, spaceVV, pageVVs),
      applyRemoteSpaceOps: (spaceId, ops) =>
        this.handleRemoteSpaceOps(spaceId, ops),
      applyRemotePageOps: (pageId, ops) =>
        this.handleRemotePageOps(pageId, ops),
    };
  }

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  identity = {
    get: async (): Promise<Identity> => {
      const rows = await this.driver.db.execute<{
        public_key: string;
        name: string;
        avatar: string | null;
      }>("SELECT public_key, name, avatar FROM identity WHERE id = 1");

      if (rows.length === 0) {
        // First run — generate keypair
        const { publicKey, privateKey } =
          await this.driver.crypto.generateKeypair();
        await this.driver.db.run(
          "INSERT INTO identity (id, public_key, private_key, name) VALUES (1, ?, ?, '')",
          [publicKey, privateKey],
        );
        return { publicKey, name: "", avatar: null };
      }

      const row = rows[0];
      return {
        publicKey: row.public_key,
        name: row.name,
        avatar: row.avatar,
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
        await this.driver.db.run(
          `UPDATE identity SET ${sets.join(", ")} WHERE id = 1`,
          params,
        );
      }

      return this.identity.get();
    },
  };

  // ---------------------------------------------------------------------------
  // Peers
  // ---------------------------------------------------------------------------

  peers = {
    list: async (): Promise<Peer[]> => {
      const rows = await this.driver.db.execute<{
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

    trust: async (publicKey: string, name?: string): Promise<Peer> => {
      await this.driver.db.run(
        `INSERT INTO peers (public_key, name, trusted) VALUES (?, ?, 1)
         ON CONFLICT(public_key) DO UPDATE SET trusted = 1, name = COALESCE(?, name)`,
        [publicKey, name ?? "", name ?? null],
      );
      const rows = await this.driver.db.execute<{
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
      await this.driver.db.run(
        "UPDATE peers SET trusted = 0 WHERE public_key = ?",
        [publicKey],
      );
    },

    remove: async (publicKey: string): Promise<void> => {
      await this.driver.db.run("DELETE FROM peers WHERE public_key = ?", [
        publicKey,
      ]);
    },
  };

  // ---------------------------------------------------------------------------
  // Spaces
  // ---------------------------------------------------------------------------

  spaces = {
    list: async (): Promise<Space[]> => {
      const rows = await this.driver.db.execute<{
        id: string;
        name: string;
        created_at: string;
      }>("SELECT * FROM spaces ORDER BY name");
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
      }));
    },

    get: async (id: string): Promise<Space & { members: SpaceMember[] }> => {
      const spaceRows = await this.driver.db.execute<{
        id: string;
        name: string;
        created_at: string;
      }>("SELECT * FROM spaces WHERE id = ?", [id]);

      if (spaceRows.length === 0) throw new Error(`Space not found: ${id}`);
      const s = spaceRows[0];

      const memberRows = await this.driver.db.execute<{
        space_id: string;
        public_key: string;
        name: string;
        role: string;
        added_at: string;
      }>("SELECT * FROM space_members WHERE space_id = ? ORDER BY added_at", [
        id,
      ]);

      return {
        id: s.id,
        name: s.name,
        createdAt: s.created_at,
        members: memberRows.map((m) => ({
          spaceId: m.space_id,
          publicKey: m.public_key,
          name: m.name,
          role: m.role as "owner" | "editor",
          addedAt: m.added_at,
        })),
      };
    },

    create: async (name: string): Promise<Space> => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const identity = await this.identity.get();

      await this.driver.db.run(
        "INSERT INTO spaces (id, name, created_at) VALUES (?, ?, ?)",
        [id, name, now],
      );

      await this.driver.db.run(
        "INSERT INTO space_members (space_id, public_key, name, role, added_at) VALUES (?, ?, ?, 'owner', ?)",
        [id, identity.publicKey, identity.name, now],
      );

      // Generate CRDT ops
      await this.emitSpaceOp(id, {
        op: "space_set",
        field: "name",
        value: name,
      });

      await this.emitSpaceOp(id, {
        op: "member_add",
        publicKey: identity.publicKey,
        name: identity.name,
      });

      return { id, name, createdAt: now };
    },

    rename: async (id: string, name: string): Promise<void> => {
      await this.driver.db.run("UPDATE spaces SET name = ? WHERE id = ?", [
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

    leave: async (id: string): Promise<void> => {
      const identity = await this.identity.get();
      await this.emitSpaceOp(id, {
        op: "member_remove",
        publicKey: identity.publicKey,
      });
      await this.driver.db.run(
        "DELETE FROM space_members WHERE space_id = ? AND public_key = ?",
        [id, identity.publicKey],
      );
      // Clean up local space data
      await this.driver.db.run("DELETE FROM spaces WHERE id = ?", [id]);
      this.notifySpaceChange(id);
    },

    removeMember: async (spaceId: string, publicKey: string): Promise<void> => {
      await this.emitSpaceOp(spaceId, { op: "member_remove", publicKey });
      await this.driver.db.run(
        "DELETE FROM space_members WHERE space_id = ? AND public_key = ?",
        [spaceId, publicKey],
      );
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
    createInvite: async (spaceId: string): Promise<SpaceInvite> => {
      const topicBytes = new Uint8Array(32);
      crypto.getRandomValues(topicBytes);
      const topic = bytesToHex(topicBytes);

      const secretBytes = new Uint8Array(32);
      crypto.getRandomValues(secretBytes);
      const secret = bytesToHex(secretBytes);

      const space = await this.spaces.get(spaceId);
      const signalUrl = (await this.storage.get<string>("signalUrl")) ?? "";

      return { topic, secret, signalUrl, spaceId, spaceName: space.name };
    },

    waitForPeer: async (
      invite: SpaceInvite,
      callbacks?: PairCallbacks,
    ): Promise<void> => {
      if (!this.replicator) throw new Error("Replicator not initialized");
      const identity = await this.identity.get();
      const privateKey = await this.getPrivateKey();

      await this.replicator.startPairing({
        invite,
        role: "initiator",
        localPublicKey: identity.publicKey,
        localName: identity.name,
        privateKey,
        callbacks: {
          onConnected: callbacks?.onConnected,
          onPeerIdentity: callbacks?.onPeerIdentity,
          onComplete: async (peer) => {
            await this.peers.trust(peer.publicKey, peer.name);
            // Add the new peer as a member of the space
            await this.emitSpaceOp(invite.spaceId, {
              op: "member_add",
              publicKey: peer.publicKey,
              name: peer.name,
            });
            await this.driver.db.run(
              "INSERT OR IGNORE INTO space_members (space_id, public_key, name, role, added_at) VALUES (?, ?, ?, 'editor', ?)",
              [
                invite.spaceId,
                peer.publicKey,
                peer.name,
                new Date().toISOString(),
              ],
            );
            this.notifySpaceChange(invite.spaceId);
            callbacks?.onComplete?.(peer);
          },
          onError: callbacks?.onError,
        },
      });
    },

    acceptInvite: async (
      invite: SpaceInvite,
      callbacks?: PairCallbacks,
    ): Promise<void> => {
      if (!this.replicator) throw new Error("Replicator not initialized");
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
          onComplete: async (peer) => {
            await this.peers.trust(peer.publicKey, peer.name);

            // Create the space locally from invite metadata
            const now = new Date().toISOString();
            await this.driver.db.run(
              "INSERT OR IGNORE INTO spaces (id, name, created_at) VALUES (?, ?, ?)",
              [invite.spaceId, invite.spaceName, now],
            );
            // Add self as editor
            await this.driver.db.run(
              "INSERT OR IGNORE INTO space_members (space_id, public_key, name, role, added_at) VALUES (?, ?, ?, 'editor', ?)",
              [invite.spaceId, identity.publicKey, identity.name, now],
            );
            // Add the initiator as owner (so hello exchange can identify shared spaces)
            await this.driver.db.run(
              "INSERT OR IGNORE INTO space_members (space_id, public_key, name, role, added_at) VALUES (?, ?, ?, 'owner', ?)",
              [invite.spaceId, peer.publicKey, peer.name, now],
            );

            // Replicator.addPeer is called automatically after pairing completes
            this.notifySpaceChange(invite.spaceId);
            callbacks?.onComplete?.(peer);
          },
          onError: callbacks?.onError,
        },
      });
    },

    cancel: async (): Promise<void> => {
      if (this.replicator) await this.replicator.cancelPairing();
    },
  };

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
        sql = `SELECT p.*, EXISTS(SELECT 1 FROM pages c WHERE c.parent_id = p.id) as has_children
               FROM pages p WHERE p.space_id = ? AND p.parent_id IS NULL`;
        params.push(spaceId);
      } else {
        sql = `SELECT p.*, EXISTS(SELECT 1 FROM pages c WHERE c.parent_id = p.id) as has_children
               FROM pages p WHERE p.space_id = ? AND p.parent_id = ?`;
        params.push(spaceId, parentId);
      }

      if (!options?.includeTasks) {
        sql += " AND p.task = 0";
      }

      sql += ' ORDER BY p."order" ASC';

      const rows = await this.driver.db.execute<{
        id: string;
        title: string;
        auto_title: number;
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
        autoTitle: r.auto_title === 1,
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
      const rows = await this.driver.db.execute<{
        id: string;
        title: string;
        auto_title: number;
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
        `SELECT p.*, EXISTS(SELECT 1 FROM pages c WHERE c.parent_id = p.id) as has_children
         FROM pages p WHERE p.id = ?`,
        [id],
      );

      if (rows.length === 0) {
        throw new Error(`Page not found: ${id}`);
      }

      const r = rows[0];

      let { snapshot, snapshotClock } = await this.loadLatestSnapshot(id);
      if (!snapshot || snapshot.length === 0) {
        // No snapshot — try to rebuild from persisted ops (e.g. synced from peer)
        snapshot = await this.rebuildSnapshotFromOps(id);
      }
      if (!snapshot || snapshot.length === 0) {
        // Truly empty page — create default block
        snapshot = [
          {
            id: crypto.randomUUID(),
            type: "heading1",
            charRuns: [],
            formats: [],
          },
        ];
      }

      // Ensure snapshot content is encoded as CRDT ops for P2P sync.
      // Pages migrated from the server model have snapshots but no ops.
      await this.ensureSnapshotOps(id, snapshot);

      const parents = await this.buildParentChain(r.parent_id);

      return {
        id: r.id,
        title: r.title,
        autoTitle: r.auto_title === 1,
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
        snapshot,
        snapshotClock,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        parents,
      };
    },

    create: async (data: PageCreateInput): Promise<PageFull> => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const orderRows = await this.driver.db.execute<{
        max_order: number | null;
      }>(
        data.parentId
          ? 'SELECT MAX("order") as max_order FROM pages WHERE parent_id = ?'
          : 'SELECT MAX("order") as max_order FROM pages WHERE parent_id IS NULL',
        data.parentId ? [data.parentId] : [],
      );
      const order = (orderRows[0]?.max_order ?? 0) + 1;

      await this.driver.db.run(
        `INSERT INTO pages (id, title, parent_id, "order", space_id, task, scheduled_at, duration, all_day, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          data.title,
          data.parentId,
          order,
          data.spaceId ?? null,
          data.task ? 1 : 0,
          data.scheduledAt ?? null,
          data.duration ?? null,
          data.allDay !== undefined ? (data.allDay ? 1 : 0) : null,
          now,
          now,
        ],
      );

      // Create the initial block and persist it as snapshot + op so every
      // peer that syncs this page gets the same block ID.
      const initialBlockId = crypto.randomUUID();
      const initialBlocks: import("@/deserializer/loadPage").Block[] = [
        {
          id: initialBlockId,
          type: "heading1",
          charRuns: [],
          formats: [],
        },
      ];
      await this.saveSnapshot(id, initialBlocks, null);

      // Persist a block_insert op so the initial block is part of the CRDT log
      const blockInsertOp = {
        op: "block_insert" as const,
        id: `__init__:0`,
        clock: { counter: 0, peerId: "__init__" },
        pageId: id,
        afterBlockId: null,
        blockId: initialBlockId,
        blockType: "heading1" as const,
      };
      const opData = new TextEncoder().encode(JSON.stringify(blockInsertOp));
      await this.driver.db.run(
        "INSERT OR IGNORE INTO ops (page_id, peer_id, counter, type, data, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        [id, "__init__", 0, "block_insert", opData, 0],
      );

      // Auto-generate space op if page belongs to a space
      if (data.spaceId) {
        await this.emitSpaceOp(data.spaceId, {
          op: "page_add",
          pageId: id,
          title: data.title,
          parentId: data.parentId,
          order,
          task: data.task,
          color: undefined,
          scheduledAt: data.scheduledAt ?? null,
          duration: data.duration ?? null,
          allDay: data.allDay ?? null,
        });
      }

      return this.pages.get(id);
    },

    update: async (data: PageUpdateInput): Promise<PageFull> => {
      const sets: string[] = [];
      const params: unknown[] = [];

      // Track which fields changed for space ops
      const changedFields: { field: string; value: unknown }[] = [];

      if (data.title !== undefined) {
        sets.push("title = ?");
        params.push(data.title);
        changedFields.push({ field: "title", value: data.title });
      }
      if (data.autoTitle !== undefined) {
        sets.push("auto_title = ?");
        params.push(data.autoTitle ? 1 : 0);
        changedFields.push({ field: "autoTitle", value: data.autoTitle });
      }
      if (data.color !== undefined) {
        sets.push("color = ?");
        params.push(data.color);
        changedFields.push({ field: "color", value: data.color });
      }
      if (data.scheduledAt !== undefined) {
        sets.push("scheduled_at = ?");
        params.push(data.scheduledAt);
        changedFields.push({ field: "scheduledAt", value: data.scheduledAt });
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
        await this.driver.db.run(
          `UPDATE pages SET ${sets.join(", ")} WHERE id = ?`,
          params,
        );
      }

      // Save snapshot if provided
      if (data.snapshot) {
        await this.saveSnapshot(
          data.id,
          data.snapshot,
          data.snapshotClock ?? null,
        );
      }

      // Auto-generate space ops for metadata changes
      if (changedFields.length > 0) {
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
        }
      }

      return this.pages.get(data.id);
    },

    delete: async (id: string): Promise<void> => {
      // Check if page belongs to a space before deleting
      const spaceId = await this.getPageSpaceId(id);

      const tree = await this.driver.db.execute<{ id: string }>(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM pages WHERE id = ?
           UNION ALL
           SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
         )
         SELECT id FROM subtree`,
        [id],
      );
      const ids = tree.map((r) => r.id);

      const placeholders = ids.map(() => "?").join(", ");
      const snapshotFiles = await this.driver.db.execute<{ file_path: string }>(
        `SELECT file_path FROM snapshots WHERE page_id IN (${placeholders})`,
        ids,
      );

      await this.driver.db.transaction(async (db) => {
        await db.run(`DELETE FROM ops WHERE page_id IN (${placeholders})`, ids);
        await db.run(
          `DELETE FROM snapshots WHERE page_id IN (${placeholders})`,
          ids,
        );
        await db.run(`DELETE FROM pages WHERE id IN (${placeholders})`, ids);
      });

      for (const s of snapshotFiles) {
        await this.driver.fs.delete(s.file_path);
      }

      // Generate space op for each deleted page
      if (spaceId) {
        for (const pageId of ids) {
          await this.emitSpaceOp(spaceId, { op: "page_remove", pageId });
        }
      }
    },

    move: async (data: PageMoveInput): Promise<void> => {
      const spaceId = await this.getPageSpaceId(data.id);

      const sets = ["parent_id = ?", "updated_at = ?"];
      const params: unknown[] = [data.parentId, new Date().toISOString()];

      if (data.order !== undefined) {
        sets.push('"order" = ?');
        params.push(data.order);
      }

      params.push(data.id);
      await this.driver.db.run(
        `UPDATE pages SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );

      if (spaceId) {
        await this.emitSpaceOp(spaceId, {
          op: "page_set",
          pageId: data.id,
          field: "parentId",
          value: data.parentId,
        });
        if (data.order !== undefined) {
          await this.emitSpaceOp(spaceId, {
            op: "page_set",
            pageId: data.id,
            field: "order",
            value: data.order,
          });
        }
      }
    },

    reorder: async (id: string, order: number): Promise<void> => {
      await this.driver.db.run(
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
      }
    },

    search: async (query: string): Promise<PageSearchResult[]> => {
      const rows = await this.driver.db.execute<{
        id: string;
        title: string | null;
        parent_id: string | null;
        color: string | null;
      }>(
        "SELECT id, title, parent_id, color FROM pages WHERE title LIKE ? LIMIT 20",
        [`%${query}%`],
      );

      const results: PageSearchResult[] = [];
      for (const r of rows) {
        const path = await this.buildParentChain(r.parent_id);
        results.push({
          id: r.id,
          title: r.title,
          parentId: r.parent_id,
          path,
          color: r.color,
        });
      }
      return results;
    },

    calendar: async (
      start: number,
      end: number,
    ): Promise<PageCalendarItem[]> => {
      const rows = await this.driver.db.execute<{
        id: string;
        title: string;
        auto_title: number;
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
         WHERE scheduled_at IS NOT NULL
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
          autoTitle: r.auto_title === 1,
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
      const rows = await this.driver.db.execute<{
        id: string;
        page_id: string;
        file_path: string;
        size: number;
        clock_counter: number;
        clock_peer_id: string;
        created_at: string;
        updated_at: string;
      }>("SELECT * FROM snapshots WHERE page_id = ? ORDER BY created_at DESC", [
        pageId,
      ]);

      const results: PageSnapshot[] = [];
      for (const r of rows) {
        let blocks: import("@/deserializer/loadPage").Block[] = [];
        try {
          const data = await this.driver.fs.read(r.file_path);
          if (data) {
            const json = new TextDecoder().decode(data);
            blocks = JSON.parse(json);
          }
        } catch {
          // Skip unreadable snapshots
        }
        results.push({
          id: r.id,
          pageId: r.page_id,
          blocks,
          size: r.size,
          clock: { counter: r.clock_counter, peerId: r.clock_peer_id },
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        });
      }
      return results;
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
      const path = `${this.driver.basePath}/assets/${hash}.${ext}`;

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
      const files = await this.driver.fs.list(assetsDir);
      const match = files.find((f) => f.startsWith(hash));
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
      throw new Error("Sync not initialized");
    },
    async leaveRoom() {
      throw new Error("Sync not initialized");
    },
    sendOperations() {
      throw new Error("Sync not initialized");
    },
    sendSyncRequest() {
      throw new Error("Sync not initialized");
    },
    sendSyncResponse() {
      throw new Error("Sync not initialized");
    },
    sendAwareness() {
      throw new Error("Sync not initialized");
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
  };

  /** Replace the sync implementation (called by platform init) */
  setSync(sync: Platform["sync"]): void {
    this.sync = sync;
  }

  // ---------------------------------------------------------------------------
  // Storage (key-value)
  // ---------------------------------------------------------------------------

  storage = {
    get: async <T = unknown>(key: string): Promise<T | null> => {
      const rows = await this.driver.db.execute<{ value: string }>(
        "SELECT value FROM kv WHERE key = ?",
        [key],
      );
      if (rows.length === 0) return null;
      return JSON.parse(rows[0].value) as T;
    },

    set: async (key: string, value: unknown): Promise<void> => {
      await this.driver.db.run(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
        [key, JSON.stringify(value), JSON.stringify(value)],
      );
    },

    remove: async (key: string): Promise<void> => {
      await this.driver.db.run("DELETE FROM kv WHERE key = ?", [key]);
    },
  };

  // ---------------------------------------------------------------------------
  // Ops (CRDT operation persistence)
  // ---------------------------------------------------------------------------

  ops = {
    persist: async (
      pageId: string,
      operations: import("@/editor/sync/types").Operation[],
    ): Promise<void> => {
      for (const op of operations) {
        const data = new TextEncoder().encode(JSON.stringify(op));
        await this.driver.db.run(
          "INSERT OR IGNORE INTO ops (page_id, peer_id, counter, type, data, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
          [
            pageId,
            op.clock.peerId,
            op.clock.counter,
            op.op,
            data,
            op.clock.counter,
          ],
        );
      }
    },

    load: async (
      pageId: string,
    ): Promise<import("@/editor/sync/types").Operation[]> => {
      const rows = await this.driver.db.execute<{ data: Uint8Array }>(
        "SELECT data FROM ops WHERE page_id = ? ORDER BY counter, peer_id",
        [pageId],
      );
      const ops: import("@/editor/sync/types").Operation[] = [];
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
  // Space CRDT: Remote ops handling (called by sync layer)
  // ---------------------------------------------------------------------------

  /** Apply remote space operations received from a peer */
  async handleRemoteSpaceOps(
    spaceId: string,
    ops: SpaceOperation[],
  ): Promise<void> {
    for (const op of ops) {
      await this.storeSpaceOp(op);
      await this.applySpaceOp(op);
    }
    this.notifySpaceChange(spaceId);
  }

  /** Apply remote page content operations received from a peer */
  async handleRemotePageOps(
    pageId: string,
    ops: import("@/editor/sync/types").Operation[],
  ): Promise<void> {
    for (const op of ops) {
      const data = new TextEncoder().encode(JSON.stringify(op));
      await this.driver.db.run(
        "INSERT OR IGNORE INTO ops (page_id, peer_id, counter, type, data, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        [
          pageId,
          op.clock.peerId,
          op.clock.counter,
          op.op,
          data,
          op.clock.counter,
        ],
      );
    }
  }

  /** Build a sync response for a requesting peer */
  async buildSpaceSyncResponse(
    spaceId: string,
    remoteSpaceVV: Record<string, number>,
    remotePageVVs: Record<string, Record<string, number>>,
  ): Promise<{
    spaceOps: SpaceOperation[];
    pageOps: Record<string, import("@/editor/sync/types").Operation[]>;
  }> {
    // Get missing space ops
    const allSpaceOps = await this.getSpaceOps(spaceId);
    const missingSpaceOps = allSpaceOps.filter((op) => {
      const known = remoteSpaceVV[op.clock.peerId] ?? -1;
      return op.clock.counter > known;
    });

    // Get missing page ops for all pages in this space
    const pageRows = await this.driver.db.execute<{ id: string }>(
      "SELECT id FROM pages WHERE space_id = ?",
      [spaceId],
    );

    const pageOps: Record<string, import("@/editor/sync/types").Operation[]> =
      {};
    for (const { id: pageId } of pageRows) {
      const remoteVV = remotePageVVs[pageId] ?? {};
      const rows = await this.driver.db.execute<{
        data: Uint8Array;
        peer_id: string;
        counter: number;
      }>(
        "SELECT data, peer_id, counter FROM ops WHERE page_id = ? ORDER BY counter",
        [pageId],
      );

      const missing: import("@/editor/sync/types").Operation[] = [];
      for (const row of rows) {
        const known = remoteVV[row.peer_id] ?? -1;
        if (row.counter > known) {
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

  /** Get the space version vector (for sync requests) */
  async getSpaceVV(spaceId: string): Promise<Record<string, number>> {
    const nsPageId = `space:${spaceId}`;
    const rows = await this.driver.db.execute<{
      peer_id: string;
      max_counter: number;
    }>(
      "SELECT peer_id, MAX(counter) as max_counter FROM ops WHERE page_id = ? GROUP BY peer_id",
      [nsPageId],
    );
    const vv: Record<string, number> = {};
    for (const r of rows) vv[r.peer_id] = r.max_counter;
    return vv;
  }

  /** Get page version vectors for all pages in a space */
  async getPageVVs(
    spaceId: string,
  ): Promise<Record<string, Record<string, number>>> {
    const pageRows = await this.driver.db.execute<{ id: string }>(
      "SELECT id FROM pages WHERE space_id = ?",
      [spaceId],
    );

    const result: Record<string, Record<string, number>> = {};
    for (const { id: pageId } of pageRows) {
      const rows = await this.driver.db.execute<{
        peer_id: string;
        max_counter: number;
      }>(
        "SELECT peer_id, MAX(counter) as max_counter FROM ops WHERE page_id = ? GROUP BY peer_id",
        [pageId],
      );
      if (rows.length > 0) {
        const vv: Record<string, number> = {};
        for (const r of rows) vv[r.peer_id] = r.max_counter;
        result[pageId] = vv;
      }
    }
    return result;
  }


  // ---------------------------------------------------------------------------
  // Private: Space CRDT helpers
  // ---------------------------------------------------------------------------

  private async getPrivateKey(): Promise<string> {
    const rows = await this.driver.db.execute<{ private_key: string }>(
      "SELECT private_key FROM identity WHERE id = 1",
    );
    return rows[0].private_key;
  }

  /**
   * Rebuild a page's Block[] from persisted CRDT ops when no snapshot file exists.
   * This handles the case where a peer received ops via sync but has no snapshot yet.
   */
  private async rebuildSnapshotFromOps(
    pageId: string,
  ): Promise<import("@/deserializer/loadPage").Block[] | null> {
    const rows = await this.driver.db.execute<{ data: Uint8Array }>(
      "SELECT data FROM ops WHERE page_id = ? ORDER BY counter, peer_id",
      [pageId],
    );
    if (rows.length === 0) return null;

    const { applyRemoteOps } = await import("@/editor/sync/crdt-helpers");

    // Start with an empty page and apply all ops
    let page: import("@/deserializer/loadPage").Page = {
      id: pageId,
      title: "",
      blocks: [],
    };

    const ops: import("@/editor/sync/types").Operation[] = [];
    for (const r of rows) {
      try {
        ops.push(JSON.parse(new TextDecoder().decode(r.data as Uint8Array)));
      } catch { /* skip corrupted */ }
    }

    if (ops.length === 0) return null;

    page = applyRemoteOps(page, ops);

    if (page.blocks.length === 0) return null;

    // Save the rebuilt snapshot for future loads
    await this.saveSnapshot(pageId, page.blocks, null);

    return page.blocks;
  }

  /**
   * Ensure a page's snapshot content is stored as CRDT ops.
   * Called on page load — only runs once per page (skips if ops already exist).
   */
  private async ensureSnapshotOps(
    pageId: string,
    blocks: import("@/deserializer/loadPage").Block[],
  ): Promise<void> {
    // Check if ops already exist for this page
    const countRows = await this.driver.db.execute<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM ops WHERE page_id = ?",
      [pageId],
    );
    if (countRows[0].cnt > 0) return;

    // Check if the snapshot has any actual content worth encoding
    const hasContent = blocks.some(
      (b) =>
        ("charRuns" in b && b.charRuns && b.charRuns.length > 0) ||
        b.type === "image" ||
        b.type === "line",
    );
    if (!hasContent) return;

    // Generate ops from the snapshot
    const ops = snapshotToOps(pageId, blocks);
    if (ops.length === 0) return;

    // Persist to SQLite
    for (const op of ops) {
      const data = new TextEncoder().encode(JSON.stringify(op));
      await this.driver.db.run(
        "INSERT OR IGNORE INTO ops (page_id, peer_id, counter, type, data, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        [
          pageId,
          op.clock.peerId,
          op.clock.counter,
          op.op,
          data,
          op.clock.counter,
        ],
      );
    }
  }

  private async getPageSpaceId(pageId: string): Promise<string | null> {
    const rows = await this.driver.db.execute<{ space_id: string | null }>(
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

    // Broadcast to peers
    if (this.replicator) {
      this.replicator.pushSpaceOps(spaceId, [op]);
    }
  }

  private async storeSpaceOp(op: SpaceOperation): Promise<void> {
    const nsPageId = `space:${op.spaceId}`;
    const data = new TextEncoder().encode(JSON.stringify(op));
    await this.driver.db.run(
      "INSERT OR IGNORE INTO ops (page_id, peer_id, counter, type, data, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      [
        nsPageId,
        op.clock.peerId,
        op.clock.counter,
        op.op,
        data,
        op.clock.counter,
      ],
    );

    // Update local HLC counter
    const current = this.spaceHlcCounters.get(op.spaceId) ?? 0;
    if (op.clock.counter > current) {
      this.spaceHlcCounters.set(op.spaceId, op.clock.counter);
    }
  }

  private async getSpaceOps(spaceId: string): Promise<SpaceOperation[]> {
    const nsPageId = `space:${spaceId}`;
    const rows = await this.driver.db.execute<{ data: Uint8Array }>(
      "SELECT data FROM ops WHERE page_id = ? ORDER BY counter, peer_id",
      [nsPageId],
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

  private async applySpaceOp(op: SpaceOperation): Promise<void> {
    const now = new Date().toISOString();
    switch (op.op) {
      case "space_set":
        if (op.field === "name") {
          await this.driver.db.run("UPDATE spaces SET name = ? WHERE id = ?", [
            op.value,
            op.spaceId,
          ]);
        }
        break;

      case "member_add":
        await this.driver.db.run(
          `INSERT INTO space_members (space_id, public_key, name, role, added_at)
           VALUES (?, ?, ?, 'editor', ?)
           ON CONFLICT(space_id, public_key) DO UPDATE SET name = ?`,
          [op.spaceId, op.publicKey, op.name, now, op.name],
        );
        // Also trust this peer
        await this.driver.db.run(
          `INSERT INTO peers (public_key, name, trusted) VALUES (?, ?, 1)
           ON CONFLICT(public_key) DO UPDATE SET name = COALESCE(?, name), trusted = 1`,
          [op.publicKey, op.name, op.name],
        );
        break;

      case "member_remove":
        await this.driver.db.run(
          "DELETE FROM space_members WHERE space_id = ? AND public_key = ?",
          [op.spaceId, op.publicKey],
        );
        break;

      case "page_add": {
        // Create page if it doesn't exist locally
        const exists = await this.driver.db.execute(
          "SELECT 1 FROM pages WHERE id = ?",
          [op.pageId],
        );
        if (exists.length === 0) {
          await this.driver.db.run(
            `INSERT INTO pages (id, title, parent_id, "order", space_id, task, color, scheduled_at, duration, all_day, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              op.pageId,
              op.title,
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
        }
        break;
      }

      case "page_remove":
        await this.driver.db.run("DELETE FROM pages WHERE id = ?", [op.pageId]);
        break;

      case "page_set": {
        const fieldMap: Record<string, string> = {
          title: "title",
          autoTitle: "auto_title",
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
          if (op.field === "task" || op.field === "autoTitle") {
            val = val ? 1 : 0;
          } else if (op.field === "allDay") {
            val = val === null ? null : val ? 1 : 0;
          }
          await this.driver.db.run(
            `UPDATE pages SET ${col} = ?, updated_at = ? WHERE id = ?`,
            [val, now, op.pageId],
          );
        }
        break;
      }
    }
  }

  private notifySpaceChange(spaceId: string) {
    for (const cb of this.spaceChangeListeners) cb(spaceId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async buildParentChain(
    parentId: string | null,
  ): Promise<{ id: string; title: string; color?: string | null }[]> {
    const chain: { id: string; title: string; color?: string | null }[] = [];
    let currentId = parentId;

    while (currentId) {
      const rows = await this.driver.db.execute<{
        id: string;
        title: string;
        parent_id: string | null;
        color: string | null;
      }>("SELECT id, title, parent_id, color FROM pages WHERE id = ?", [
        currentId,
      ]);

      if (rows.length === 0) break;

      const r = rows[0];
      chain.unshift({ id: r.id, title: r.title, color: r.color });
      currentId = r.parent_id;
    }

    return chain;
  }

  private async loadLatestSnapshot(pageId: string): Promise<{
    snapshot: import("@/deserializer/loadPage").Block[] | null;
    snapshotClock: { counter: number; peerId: string } | null;
  }> {
    const rows = await this.driver.db.execute<{
      file_path: string;
      clock_counter: number;
      clock_peer_id: string;
    }>(
      "SELECT file_path, clock_counter, clock_peer_id FROM snapshots WHERE page_id = ? ORDER BY created_at DESC LIMIT 1",
      [pageId],
    );

    if (rows.length === 0) {
      return { snapshot: null, snapshotClock: null };
    }

    const r = rows[0];
    const data = await this.driver.fs.read(r.file_path);

    if (!data) {
      return { snapshot: null, snapshotClock: null };
    }

    try {
      const json = new TextDecoder().decode(data);
      const blocks = JSON.parse(
        json,
      ) as import("@/deserializer/loadPage").Block[];
      return {
        snapshot: blocks,
        snapshotClock: { counter: r.clock_counter, peerId: r.clock_peer_id },
      };
    } catch {
      return { snapshot: null, snapshotClock: null };
    }
  }

  private async saveSnapshot(
    pageId: string,
    blocks: import("@/deserializer/loadPage").Block[],
    clock: { counter: number; peerId: string } | null,
  ): Promise<void> {
    const json = JSON.stringify(blocks);
    const data = new TextEncoder().encode(json);

    const snapshotId = crypto.randomUUID();
    const filePath = `${this.driver.basePath}/snapshots/${pageId}/${snapshotId}.bin`;
    const now = new Date().toISOString();

    await this.driver.fs.write(filePath, data);

    await this.driver.db.run(
      `INSERT INTO snapshots (page_id, file_path, size, clock_counter, clock_peer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        pageId,
        filePath,
        data.length,
        clock?.counter ?? 0,
        clock?.peerId ?? "",
        now,
        now,
      ],
    );

    // Garbage collect: keep max 50 snapshots per page
    const old = await this.driver.db.execute<{ id: number; file_path: string }>(
      `SELECT id, file_path FROM snapshots WHERE page_id = ?
       ORDER BY created_at DESC LIMIT -1 OFFSET 50`,
      [pageId],
    );
    for (const s of old) {
      await this.driver.fs.delete(s.file_path);
      await this.driver.db.run("DELETE FROM snapshots WHERE id = ?", [s.id]);
    }
  }
}

// =============================================================================
// Utilities
// =============================================================================

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
