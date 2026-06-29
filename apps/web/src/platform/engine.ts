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
import { invariant } from "@shared/invariant";
import type { Driver, CryptoDriver, DbRow } from "./driver";
import type { HLC } from "@cypherkit/editor";
import type { ReplicatorHost } from "./sync";
import { nanoid } from "nanoid";
// Deep import the DOM-free block-order module rather than the `/internal`
// barrel — the barrel re-exports rendering/font code that touches `document`,
// which crashes the engine when it runs inside the SharedWorker (Phase 2).
import { sortBlocksByOrder } from "@cypherkit/editor/sync/block-order";

/** Minimal interface the engine uses to push ops — avoids circular imports */
interface EngineReplicator {
  pushSpaceOps(spaceId: string, ops: SpaceOperation[]): void;
  pushPageOps(
    spaceId: string,
    pageId: string,
    ops: import("@cypherkit/editor/state-types").Operation[],
  ): void;
  requestAsset(hash: string): Promise<boolean>;
  addPeer(publicKey: string): Promise<void>;
  removePeer(publicKey: string): Promise<void>;
  startPairing(opts: {
    invite: SpaceInvite;
    role: "initiator" | "acceptor";
    spaceName?: string;
    localPublicKey: string;
    localName: string;
    privateKey: string;
    callbacks: PairCallbacks;
  }): Promise<void>;
  cancelPairing(): Promise<void>;
}

// =============================================================================
// Schema & Migrations
// =============================================================================

const SCHEMA_VERSION = 0;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS identity (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    public_key  TEXT NOT NULL,
    private_key TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    avatar      TEXT
  );

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
    created_at  TEXT NOT NULL
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
    execute: <T extends DbRow = DbRow>(sql: string, params?: unknown[]) =>
      this.driver.db.execute<T>(sql, params),
    run: (sql: string, params?: unknown[]) => this.driver.db.run(sql, params),
    exec: (sql: string) => this.driver.db.exec(sql),
    getPendingMigrations: () => this.getPendingMigrations(),
    applyMigrations: () => this.applyMigrations(),
  };

  /** Initialize the database schema. Call once at startup. */
  async init(): Promise<void> {
    await this.driver.db.exec(SCHEMA_SQL);
    // In staging, migrations are applied explicitly via DevToolbar.
    if (import.meta.env.VITE_STAGING !== "true") {
      await this.applyMigrations();
    }
    // Create the identity now, before any RPC is served, so concurrent
    // first-load callers all observe an existing row instead of racing to
    // insert it.
    await this.ensureIdentity();
    await this.loadSpaceHlcCounters();
  }

  // ---------------------------------------------------------------------------
  // Migrations — sequential, forward-only, idempotent
  // Bump SCHEMA_VERSION when adding a new migration.
  // ---------------------------------------------------------------------------

  /** Returns how many migrations are pending (0 means schema is up to date). */
  async getPendingMigrations(): Promise<number> {
    const [{ user_version }] = await this.driver.db.execute<{
      user_version: number;
    }>("PRAGMA user_version");
    return Math.max(0, SCHEMA_VERSION - (user_version as number));
  }

  /** Apply all pending migrations. Safe to call multiple times. */
  async applyMigrations(): Promise<void> {
    const [{ user_version }] = await this.driver.db.execute<{
      user_version: number;
    }>("PRAGMA user_version");

    if (user_version < SCHEMA_VERSION) {
      await this.driver.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  /** Load max HLC counters and LWW winners from persisted ops so we never regress after restart */
  private async loadSpaceHlcCounters(): Promise<void> {
    const rows = await this.driver.db.execute<{
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
    const scopes = await this.driver.db.execute<{ scope_id: string }>(
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
        return spaces.map((s) => s.id);
      },
      getSpaceMembers: async (spaceId: string) => {
        const space = await this.spaces.get(spaceId);
        return space.members.map((m) => ({ publicKey: m.publicKey }));
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
        const path = `${this.driver.basePath}/assets/${hash}.${ext}`;
        if (!(await this.driver.fs.exists(path))) {
          await this.driver.fs.write(path, data);
        }
      },
      buildPageSyncResponse: (
        pageId: string,
        remoteVV: Record<string, number>,
      ) => this.buildPageSyncResponse(pageId, remoteVV),
      getPeerSharedKey: async (publicKey: string): Promise<string | null> => {
        const rows = await this.driver.db.execute<{
          shared_key: string | null;
        }>("SELECT shared_key FROM peers WHERE public_key = ?", [publicKey]);
        return rows[0]?.shared_key ?? null;
      },
      updatePeerLastSeen: async (publicKey: string): Promise<void> => {
        await this.driver.db.run(
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
      const rows = await this.driver.db.execute<{ id: number }>(
        "SELECT id FROM identity WHERE id = 1",
      );
      if (rows.length > 0) return;
      const { publicKey, privateKey } =
        await this.driver.crypto.generateKeypair();
      await this.driver.db.run(
        "INSERT OR IGNORE INTO identity (id, public_key, private_key, name) VALUES (1, ?, ?, '')",
        [publicKey, privateKey],
      );
    })());
  }

  identity = {
    get: async (): Promise<Identity> => {
      await this.ensureIdentity();
      const rows = await this.driver.db.execute<{
        public_key: string;
        name: string;
        avatar: string | null;
      }>("SELECT public_key, name, avatar FROM identity WHERE id = 1");

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

      // Propagate changes to all spaces the user belongs to
      const identity = await this.identity.get();
      const memberships = await this.driver.db.execute<{ space_id: string }>(
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

    trust: async (
      publicKey: string,
      name?: string,
      sharedKey?: string,
    ): Promise<Peer> => {
      const now = Date.now();
      await this.driver.db.run(
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
      const identity = await this.identity.get();
      const rows = await this.driver.db.execute<{
        id: string;
        name: string;
        created_at: string;
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
        avatar: string | null;
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
          avatar: m.avatar,
          addedAt: m.added_at,
        })),
      };
    },

    create: async (name: string): Promise<Space> => {
      const id = nanoid(10);
      const now = new Date().toISOString();
      const identity = await this.identity.get();

      await this.driver.db.run(
        "INSERT INTO spaces (id, name, created_at) VALUES (?, ?, ?)",
        [id, name, now],
      );

      await this.driver.db.run(
        "INSERT INTO space_members (space_id, public_key, name, added_at) VALUES (?, ?, ?, ?)",
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

    archive: async (id: string): Promise<void> => {
      const now = new Date().toISOString();
      await this.driver.db.run(
        "UPDATE spaces SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
        [now, id],
      );
      this.notifySpaceChange(id);
    },

    unarchive: async (id: string): Promise<void> => {
      await this.driver.db.run(
        "UPDATE spaces SET archived_at = NULL WHERE id = ?",
        [id],
      );
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
        await this.driver.db.run(
          `UPDATE space_members SET ${col} = ? WHERE space_id = ? AND public_key = ?`,
          [value, spaceId, publicKey],
        );
      }
      if (field === "name") {
        await this.driver.db.run(
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
    createInvite: async (spaceId: string): Promise<SpaceInvite> => {
      const topicBytes = new Uint8Array(32);
      crypto.getRandomValues(topicBytes);
      const topic = bytesToHex(topicBytes);

      const secretBytes = new Uint8Array(32);
      crypto.getRandomValues(secretBytes);
      const secret = bytesToHex(secretBytes);

      return { topic, secret, spaceId };
    },

    waitForPeer: async (
      invite: SpaceInvite,
      callbacks?: PairCallbacks,
    ): Promise<void> => {
      invariant(this.replicator, "Replicator not initialized");
      const identity = await this.identity.get();
      const privateKey = await this.getPrivateKey();
      const space = await this.spaces.get(invite.spaceId);

      await this.replicator.startPairing({
        invite,
        role: "initiator",
        spaceName: space.name,
        localPublicKey: identity.publicKey,
        localName: identity.name,
        privateKey,
        callbacks: {
          multi: callbacks?.multi,
          onConnected: callbacks?.onConnected,
          onPeerIdentity: callbacks?.onPeerIdentity,
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
            await this.driver.db.run(
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
            await this.driver.db.run(
              `INSERT INTO spaces (id, name, created_at) VALUES (?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET archived_at = NULL`,
              [invite.spaceId, spaceName ?? "", now],
            );
            // Add self as member
            await this.driver.db.run(
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
            await this.driver.db.run(
              `INSERT INTO space_members (space_id, public_key, name, added_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(space_id, public_key) DO UPDATE SET name = ?, archived_at = NULL`,
              [invite.spaceId, peer.publicKey, peer.name, now, peer.name],
            );

            // Replicator.addPeer is called automatically after pairing completes
            this.notifySpaceChange(invite.spaceId);
            callbacks?.onComplete?.(peer, spaceName);
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
        | import("@cypherkit/editor/serlization/loadPage").Block[]
        | null = null;
      if (cached && vvEqual(cached.vv, currentVV) && cached.blocks.length > 0) {
        blocks = cached.blocks;
      } else {
        // Slow path: replay full op log and persist a fresh snapshot. The saved
        // vv is derived from the exact ops the rebuild consumed, so it always
        // describes the blocks it ships with.
        const rebuilt = await this.rebuildBlocksFromOps(id);
        blocks = rebuilt?.blocks ?? null;
        if (rebuilt && blocks && blocks.length > 0) {
          // Fire-and-forget — don't block the page open on the write.
          this.snapshots.save(id, blocks, rebuilt.vv).catch(() => {});
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
        await this.driver.db.run(
          "INSERT OR IGNORE INTO ops (scope_id, peer_id, clock, type, data, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
          [id, "__init__", 0, "block_insert", opData, Date.now()],
        );
      }

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
        blocks,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        parents,
      };
    },

    create: async (data: PageCreateInput): Promise<PageFull> => {
      const id = nanoid(10);
      const now = new Date().toISOString();

      const orderRows = await this.driver.db.execute<{
        max_order: number | null;
      }>(
        data.parentId
          ? 'SELECT MAX("order") as max_order FROM pages WHERE parent_id = ? AND archived_at IS NULL'
          : 'SELECT MAX("order") as max_order FROM pages WHERE parent_id IS NULL AND archived_at IS NULL',
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
      await this.driver.db.run(
        "INSERT OR IGNORE INTO ops (scope_id, peer_id, clock, type, data, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        [id, "__init__", 0, "block_insert", opData, Date.now()],
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
          this.notifySpaceChange(spaceId);
        }
      }

      return this.pages.get(data.id);
    },

    delete: async (id: string): Promise<void> => {
      // Check if page belongs to a space before deleting
      const spaceId = await this.getPageSpaceId(id);

      const tree = await this.driver.db.execute<{ id: string }>(
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

      await this.driver.db.run(
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

    move: async (data: PageMoveInput): Promise<void> => {
      const spaceId = await this.getPageSpaceId(data.id);

      // When no explicit order is supplied (e.g. nesting a page under a new
      // parent), append it to the end of the destination's children. Without
      // this the page would keep its old order value, which is meaningless in
      // the new sibling set and collides arbitrarily.
      let order = data.order;
      if (order === undefined) {
        const orderRows = await this.driver.db.execute<{
          max_order: number | null;
        }>(
          data.parentId === null
            ? 'SELECT MAX("order") as max_order FROM pages WHERE parent_id IS NULL AND id != ? AND archived_at IS NULL'
            : 'SELECT MAX("order") as max_order FROM pages WHERE parent_id = ? AND id != ? AND archived_at IS NULL',
          data.parentId === null ? [data.id] : [data.parentId, data.id],
        );
        order = (orderRows[0]?.max_order ?? 0) + 1;
      }

      await this.driver.db.run(
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
        this.notifySpaceChange(spaceId);
      }
    },

    search: async (query: string): Promise<PageSearchResult[]> => {
      const rows = await this.driver.db.execute<{
        id: string;
        title: string | null;
        parent_id: string | null;
        color: string | null;
      }>(
        "SELECT id, title, parent_id, color FROM pages WHERE title LIKE ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 20",
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
        data: Uint8Array;
        timestamp: number;
      }>(
        "SELECT data, timestamp FROM ops WHERE scope_id = ? ORDER BY clock, peer_id",
        [pageId],
      );
      if (rows.length === 0) return [];

      type ParsedRow = {
        op: import("@cypherkit/editor/state-types").Operation;
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
        await import("@cypherkit/editor/sync/reducer");

      let state = createEmptyPageState(pageId);
      const insertedCharIds = new Set<string>();
      const deferredOps: import("@cypherkit/editor/state-types").Operation[] =
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
          state = applyOp(state, op);
        }

        if (sampleIndices.has(i)) {
          let snapshotState = state;
          for (const deferred of deferredOps) {
            snapshotState = applyOp(snapshotState, deferred);
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
    operations: import("@cypherkit/editor/state-types").Operation[],
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
      await this.driver.db.run(
        `INSERT OR IGNORE INTO ops (scope_id, peer_id, clock, type, data, timestamp) VALUES ${placeholders}`,
        params,
      );
    }
  }

  ops = {
    persist: async (
      pageId: string,
      operations: import("@cypherkit/editor/state-types").Operation[],
    ): Promise<void> => {
      await this.insertOpsBatch(pageId, operations, Date.now());
    },

    /** Convert blocks to CRDT ops and persist them (used by import) */
    writeBlocks: async (
      pageId: string,
      blocks: import("@cypherkit/editor/serlization/loadPage").Block[],
    ): Promise<void> => {
      const { blocksToOps } =
        await import("@cypherkit/editor/sync/snapshot-diff");
      const { createIdGenerator, generatePeerId } =
        await import("@cypherkit/editor/sync/id");
      const { createHLC, tickHLC } = await import("@cypherkit/editor/sync/hlc");

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
    ): Promise<import("@cypherkit/editor/state-types").Operation[]> => {
      const rows = await this.driver.db.execute<{ data: Uint8Array }>(
        "SELECT data FROM ops WHERE scope_id = ? ORDER BY clock, peer_id",
        [pageId],
      );
      const ops: import("@cypherkit/editor/state-types").Operation[] = [];
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
      blocks: import("@cypherkit/editor/serlization/loadPage").Block[],
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
          JSON.stringify({ vv, blocks: cleanBlocks }),
        );
        await this.driver.fs.write(this.snapshotPath(pageId), data);
      } catch (err) {
        console.warn("[Engine] Failed to save snapshot:", err);
      }
    },
  };

  private async loadSnapshot(pageId: string): Promise<{
    vv: Record<string, number>;
    blocks: import("@cypherkit/editor/serlization/loadPage").Block[];
  } | null> {
    try {
      const data = await this.driver.fs.read(this.snapshotPath(pageId));
      if (!data) return null;
      const parsed = JSON.parse(new TextDecoder().decode(data));
      // Snapshots written before the vv-token format (or otherwise malformed)
      // lack `vv`; treat them as untrusted so the caller replays the log and
      // rewrites a well-formed snapshot.
      if (!parsed || typeof parsed.vv !== "object" || parsed.vv === null) {
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
    const rows = await this.driver.db.execute<{
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
    for (const op of ops) {
      await this.storeSpaceOp(op);
      await this.applySpaceOp(op);

      // When a new member is added, connect to them so all peers
      // have direct connections (not routed through the inviter).
      if (op.op === "member_add" && this.replicator) {
        const identity = await this.identity.get();
        if (op.publicKey !== identity.publicKey) {
          this.replicator.addPeer(op.publicKey);
        }
      }
    }
    this.notifySpaceChange(spaceId);
  }

  /** Apply remote page content operations received from a peer */
  async handleRemotePageOps(
    pageId: string,
    ops: import("@cypherkit/editor/state-types").Operation[],
  ): Promise<void> {
    await this.insertOpsBatch(pageId, ops, Date.now());
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
      import("@cypherkit/editor/state-types").Operation[]
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
    const localVVRows = await this.driver.db.execute<{
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
      import("@cypherkit/editor/state-types").Operation[]
    > = {};
    for (const [pageId, localVV] of Object.entries(localPageVVs)) {
      const remoteVV = remotePageVVs[pageId] ?? {};

      // Skip this page if the remote already has everything we have
      const hasMissing = Object.entries(localVV).some(
        ([peerId, maxClock]) => maxClock > (remoteVV[peerId] ?? -1),
      );
      if (!hasMissing) continue;

      const rows = await this.driver.db.execute<{
        data: Uint8Array;
        peer_id: string;
        clock: number;
      }>(
        "SELECT data, peer_id, clock FROM ops WHERE scope_id = ? ORDER BY clock",
        [pageId],
      );

      const missing: import("@cypherkit/editor/state-types").Operation[] = [];
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
    ops: import("@cypherkit/editor/state-types").Operation[];
    versionVector: Record<string, number>;
  }> {
    const rows = await this.driver.db.execute<{
      data: Uint8Array;
      peer_id: string;
      clock: number;
    }>(
      "SELECT data, peer_id, clock FROM ops WHERE scope_id = ? ORDER BY clock",
      [pageId],
    );

    const missing: import("@cypherkit/editor/state-types").Operation[] = [];
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
    const rows = await this.driver.db.execute<{
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
    const rows = await this.driver.db.execute<{
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
    const rows = await this.driver.db.execute<{ private_key: string }>(
      "SELECT private_key FROM identity WHERE id = 1",
    );
    return rows[0].private_key;
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
    const targetKey = (op as { publicKey?: string }).publicKey ?? null;
    await this.driver.db.run(
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
    const rows = await this.driver.db.execute<{ data: Uint8Array }>(
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
        if (!this.lwwCheck(op.spaceId, "space", op.field, op.clock)) break;
        if (op.field === "name") {
          // Upsert so the space row is created when receiving ops for a space
          // we don't yet have locally (bootstrapping from a remote peer).
          await this.driver.db.run(
            `INSERT INTO spaces (id, name, created_at) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = ?`,
            [op.spaceId, op.value, now, op.value],
          );
        }
        break;

      case "member_add": {
        await this.driver.db.run(
          `INSERT INTO space_members (space_id, public_key, name, added_at)
           VALUES (?, ?, ?, ?)
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
          await this.driver.db.run(
            `UPDATE space_members SET ${memberCol} = ? WHERE space_id = ? AND public_key = ? AND archived_at IS NULL`,
            [op.value, op.spaceId, op.publicKey],
          );
        }
        // Also update peer name if that's what changed
        if (op.field === "name") {
          await this.driver.db.run(
            "UPDATE peers SET name = ? WHERE public_key = ?",
            [op.value, op.publicKey],
          );
        }
        break;
      }

      case "page_add": {
        if (!this.lwwCheck(op.spaceId, `page:${op.pageId}`, "_alive", op.clock))
          break;
        const exists = await this.driver.db.execute(
          "SELECT archived_at FROM pages WHERE id = ?",
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
        } else if (exists[0].archived_at !== null) {
          // Un-archive: a page_add with higher HLC wins over a prior page_remove
          await this.driver.db.run(
            "UPDATE pages SET archived_at = NULL, updated_at = ? WHERE id = ?",
            [now, op.pageId],
          );
        }
        break;
      }

      case "page_remove":
        if (!this.lwwCheck(op.spaceId, `page:${op.pageId}`, "_alive", op.clock))
          break;
        await this.driver.db.run(
          "UPDATE pages SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
          [now, op.pageId],
        );
        this.notifyPageDeleted(op.pageId);
        break;

      case "page_set": {
        if (!this.lwwCheck(op.spaceId, `page:${op.pageId}`, op.field, op.clock))
          break;
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
  ): Promise<{ id: string; title: string; color?: string | null }[]> {
    const chain: { id: string; title: string; color?: string | null }[] = [];
    const visited = new Set<string>();
    let currentId = parentId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const rows = await this.driver.db.execute<{
        id: string;
        title: string;
        parent_id: string | null;
        color: string | null;
      }>(
        "SELECT id, title, parent_id, color FROM pages WHERE id = ? AND archived_at IS NULL",
        [currentId],
      );

      if (rows.length === 0) break;

      const r = rows[0];
      chain.unshift({ id: r.id, title: r.title, color: r.color });
      currentId = r.parent_id;
    }

    return chain;
  }

  /** Load all ops for a page as parsed Operation objects */
  private async loadPageOps(
    pageId: string,
  ): Promise<import("@cypherkit/editor/state-types").Operation[]> {
    const rows = await this.driver.db.execute<{ data: Uint8Array }>(
      "SELECT data FROM ops WHERE scope_id = ? ORDER BY clock, peer_id",
      [pageId],
    );
    const ops: import("@cypherkit/editor/state-types").Operation[] = [];
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
    blocks: import("@cypherkit/editor/serlization/loadPage").Block[];
    vv: Record<string, number>;
  } | null> {
    const ops = await this.loadPageOps(pageId);
    if (ops.length === 0) return null;

    const { rebuildState } = await import("@cypherkit/editor/sync/reducer");
    const page = rebuildState(pageId, ops);
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
  const info = new TextEncoder().encode("cypher-shared-key:" + sorted);
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
