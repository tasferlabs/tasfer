/**
 * Shared Engine
 *
 * Implements the Platform interface using a Driver.
 * All business logic (SQL queries, snapshot encoding, identity management)
 * lives here — written ONCE, shared across Electron, Capacitor, and Web.
 */

import type { Platform, PageListItem, PageFull, PageCreateInput, PageUpdateInput, PageMoveInput, PageSearchResult, PageCalendarItem, PageSnapshot, Identity, Peer, Asset } from "./types";
import type { Driver } from "./driver";

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

  CREATE TABLE IF NOT EXISTS pages (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT '',
    auto_title    INTEGER NOT NULL DEFAULT 1,
    parent_id     TEXT,
    "order"       REAL NOT NULL DEFAULT 0,
    task          INTEGER NOT NULL DEFAULT 0,
    color         TEXT,
    scheduled_at  TEXT,
    duration      INTEGER,
    all_day       INTEGER,
    recurrence_id TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ops (
    id        INTEGER PRIMARY KEY,
    page_id   TEXT NOT NULL,
    peer_id   TEXT NOT NULL,
    counter   INTEGER NOT NULL,
    type      TEXT NOT NULL,
    data      BLOB NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ops_page ON ops(page_id);
  CREATE INDEX IF NOT EXISTS idx_ops_page_peer ON ops(page_id, peer_id, counter);

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

  constructor(driver: Driver) {
    this.driver = driver;
  }

  /** Initialize the database schema. Call once at startup. */
  async init(): Promise<void> {
    await this.driver.db.exec(SCHEMA_SQL);
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
        const { publicKey, privateKey } = await this.driver.crypto.generateKeypair();
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
      }>("SELECT public_key, name, trusted, last_seen FROM peers ORDER BY name");

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
  // Pages
  // ---------------------------------------------------------------------------

  pages = {
    list: async (
      parentId?: string | null,
      options?: { includeTasks?: boolean },
    ): Promise<PageListItem[]> => {
      let sql: string;
      const params: unknown[] = [];

      if (parentId === null || parentId === undefined) {
        sql = `SELECT p.*, EXISTS(SELECT 1 FROM pages c WHERE c.parent_id = p.id) as has_children
               FROM pages p WHERE p.parent_id IS NULL`;
      } else {
        sql = `SELECT p.*, EXISTS(SELECT 1 FROM pages c WHERE c.parent_id = p.id) as has_children
               FROM pages p WHERE p.parent_id = ?`;
        params.push(parentId);
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

      // Load latest snapshot — fall back to a single empty paragraph
      // so the canvas editor always has at least one block to render/interact with.
      let { snapshot, snapshotClock } = await this.loadLatestSnapshot(id);
      if (!snapshot || snapshot.length === 0) {
        snapshot = [
          {
            id: crypto.randomUUID(),
            type: "heading1",
            charRuns: [],
            formats: [],
          },
        ];
      }

      // Build parent chain
      const parents = await this.buildParentChain(r.parent_id);

      return {
        id: r.id,
        title: r.title,
        autoTitle: r.auto_title === 1,
        parentId: r.parent_id,
        order: r.order,
        hasChildren: r.has_children === 1,
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

      // Get next order value
      const orderRows = await this.driver.db.execute<{ max_order: number | null }>(
        data.parentId
          ? 'SELECT MAX("order") as max_order FROM pages WHERE parent_id = ?'
          : 'SELECT MAX("order") as max_order FROM pages WHERE parent_id IS NULL',
        data.parentId ? [data.parentId] : [],
      );
      const order = (orderRows[0]?.max_order ?? 0) + 1;

      await this.driver.db.run(
        `INSERT INTO pages (id, title, parent_id, "order", task, scheduled_at, duration, all_day, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          data.title,
          data.parentId,
          order,
          data.task ? 1 : 0,
          data.scheduledAt ?? null,
          data.duration ?? null,
          data.allDay !== undefined ? (data.allDay ? 1 : 0) : null,
          now,
          now,
        ],
      );

      return this.pages.get(id);
    },

    update: async (data: PageUpdateInput): Promise<PageFull> => {
      const sets: string[] = [];
      const params: unknown[] = [];

      if (data.title !== undefined) {
        sets.push("title = ?");
        params.push(data.title);
      }
      if (data.autoTitle !== undefined) {
        sets.push("auto_title = ?");
        params.push(data.autoTitle ? 1 : 0);
      }
      if (data.color !== undefined) {
        sets.push("color = ?");
        params.push(data.color);
      }
      if (data.scheduledAt !== undefined) {
        sets.push("scheduled_at = ?");
        params.push(data.scheduledAt);
      }
      if (data.duration !== undefined) {
        sets.push("duration = ?");
        params.push(data.duration);
      }
      if (data.allDay !== undefined) {
        sets.push("all_day = ?");
        params.push(data.allDay === null ? null : data.allDay ? 1 : 0);
      }
      if (data.task !== undefined) {
        sets.push("task = ?");
        params.push(data.task ? 1 : 0);
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
        await this.saveSnapshot(data.id, data.snapshot, data.snapshotClock ?? null);
      }

      return this.pages.get(data.id);
    },

    delete: async (id: string): Promise<void> => {
      // Collect all page IDs in the subtree (self + descendants) via recursive CTE
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

      // Collect snapshot file paths before deleting DB rows
      const placeholders = ids.map(() => "?").join(", ");
      const snapshotFiles = await this.driver.db.execute<{ file_path: string }>(
        `SELECT file_path FROM snapshots WHERE page_id IN (${placeholders})`,
        ids,
      );

      // Delete everything in a single transaction
      await this.driver.db.transaction(async (db) => {
        await db.run(`DELETE FROM ops WHERE page_id IN (${placeholders})`, ids);
        await db.run(`DELETE FROM snapshots WHERE page_id IN (${placeholders})`, ids);
        await db.run(`DELETE FROM pages WHERE id IN (${placeholders})`, ids);
      });

      // Clean up snapshot files outside the transaction
      for (const s of snapshotFiles) {
        await this.driver.fs.delete(s.file_path);
      }
    },

    move: async (data: PageMoveInput): Promise<void> => {
      const sets = ['parent_id = ?', 'updated_at = ?'];
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
    },

    reorder: async (id: string, order: number): Promise<void> => {
      await this.driver.db.run(
        'UPDATE pages SET "order" = ?, updated_at = ? WHERE id = ?',
        [order, new Date().toISOString(), id],
      );
    },

    search: async (query: string): Promise<PageSearchResult[]> => {
      const rows = await this.driver.db.execute<{
        id: string;
        title: string | null;
        parent_id: string | null;
        color: string | null;
      }>("SELECT id, title, parent_id, color FROM pages WHERE title LIKE ? LIMIT 20", [
        `%${query}%`,
      ]);

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

    calendar: async (start: number, end: number): Promise<PageCalendarItem[]> => {
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
      }>(
        "SELECT * FROM snapshots WHERE page_id = ? ORDER BY created_at DESC",
        [pageId],
      );

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
          // Skip unreadable snapshots — return empty blocks
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
    const blob = new Blob([data as BlobPart], { type: mimeType || "application/octet-stream" });
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

      // Cache a blob URL immediately from the bytes we already have
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
      // Return cached blob URL if available
      if (this.blobUrlCache.has(hash)) {
        return this.blobUrlCache.get(hash)!;
      }

      // Find the asset file (stored with extension, e.g. hash.webp)
      const assetsDir = `${this.driver.basePath}/assets`;
      const files = await this.driver.fs.list(assetsDir);
      const match = files.find((f) => f.startsWith(hash));
      if (!match) {
        throw new Error(`Asset not found: ${hash}`);
      }

      // Read the file and create a blob URL
      const data = await this.driver.fs.read(`${assetsDir}/${match}`);
      if (!data) {
        throw new Error(`Asset file unreadable: ${match}`);
      }

      const blobUrl = this.createBlobUrl(data, this.guessMimeType(match));
      this.blobUrlCache.set(hash, blobUrl);
      return blobUrl;
    },

    delete: async (hash: string): Promise<void> => {
      // Revoke cached blob URL
      const cachedUrl = this.blobUrlCache.get(hash);
      if (cachedUrl) {
        URL.revokeObjectURL(cachedUrl);
        this.blobUrlCache.delete(hash);
      }

      // Find and delete matching asset files
      const files = await this.driver.fs.list(`${this.driver.basePath}/assets`);
      for (const file of files) {
        if (file.startsWith(hash)) {
          await this.driver.fs.delete(
            `${this.driver.basePath}/assets/${file}`,
          );
        }
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Sync — platform-specific, must be provided
  // ---------------------------------------------------------------------------

  sync: Platform["sync"] = {
    async joinRoom() {
      throw new Error("Sync not implemented — provide a SyncDriver");
    },
    async leaveRoom() {
      throw new Error("Sync not implemented — provide a SyncDriver");
    },
    sendOperations() {
      throw new Error("Sync not implemented — provide a SyncDriver");
    },
    sendSyncRequest() {
      throw new Error("Sync not implemented — provide a SyncDriver");
    },
    sendSyncResponse() {
      throw new Error("Sync not implemented — provide a SyncDriver");
    },
    sendAwareness() {
      throw new Error("Sync not implemented — provide a SyncDriver");
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

  /** Replace the sync implementation (called by platform adapters) */
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

  private async loadLatestSnapshot(
    pageId: string,
  ): Promise<{
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
      const blocks = JSON.parse(json) as import("@/deserializer/loadPage").Block[];
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
  const hash = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return bytesToHex(new Uint8Array(hash));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
