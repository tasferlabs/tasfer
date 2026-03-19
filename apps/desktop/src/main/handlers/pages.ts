/**
 * Pages handlers — CRUD, search, calendar, snapshots.
 * Reimplements apps/api pages routes using SQLite.
 */

import { ipcMain, BrowserWindow } from "electron";
import { createId } from "@paralleldrive/cuid2";
import { getDb } from "../db";

// Max snapshots per page before pruning
const MAX_SNAPSHOTS = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

/** Walk up the parent chain to build ancestor path. */
function getAncestorPath(
  db: ReturnType<typeof getDb>,
  pageId: string | null,
): { id: string; title: string; color?: string | null }[] {
  const path: { id: string; title: string; color?: string | null }[] = [];
  let currentId = pageId;

  while (currentId) {
    const row = db
      .prepare("SELECT id, title, color, parentId FROM pages WHERE id = ?")
      .get(currentId) as any;
    if (!row) break;
    path.unshift({ id: row.id, title: row.title ?? "", color: row.color });
    currentId = row.parentId;
  }

  return path;
}

/** Resolve nearest ancestor color (including self). */
function resolveColor(
  db: ReturnType<typeof getDb>,
  pageId: string,
): string | null {
  let currentId: string | null = pageId;
  while (currentId) {
    const row = db
      .prepare("SELECT color, parentId FROM pages WHERE id = ?")
      .get(currentId) as any;
    if (!row) break;
    if (row.color) return row.color;
    currentId = row.parentId;
  }
  return null;
}

/** Check if a page has children. */
function hasChildren(db: ReturnType<typeof getDb>, pageId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM pages WHERE parentId = ? LIMIT 1")
    .get(pageId) as any;
  return !!row;
}

/** Get all descendant page IDs (recursive). */
function getDescendantIds(
  db: ReturnType<typeof getDb>,
  pageId: string,
): string[] {
  const ids: string[] = [];
  const stack = [pageId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const children = db
      .prepare("SELECT id FROM pages WHERE parentId = ?")
      .all(current) as { id: string }[];
    for (const child of children) {
      ids.push(child.id);
      stack.push(child.id);
    }
  }

  return ids;
}

/** Prune old snapshots if over the limit. */
function pruneSnapshots(db: ReturnType<typeof getDb>, pageId: string) {
  const count = db
    .prepare("SELECT COUNT(*) as c FROM snapshots WHERE pageId = ?")
    .get(pageId) as { c: number };

  if (count.c > MAX_SNAPSHOTS) {
    const toDelete = count.c - MAX_SNAPSHOTS;
    db.prepare(
      `DELETE FROM snapshots WHERE id IN (
        SELECT id FROM snapshots WHERE pageId = ? ORDER BY createdAt ASC LIMIT ?
      )`,
    ).run(pageId, toDelete);
  }
}

/** Emit a page event to all renderer windows. */
function emitPageEvent(event: string, data: any) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(`page:${event}`, data);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export function registerPagesHandlers() {
  // ── List pages ──────────────────────────────────────────────────────────

  ipcMain.handle(
    "pages:list",
    (
      _,
      parentId?: string | null,
      options?: { includeTasks?: boolean },
    ) => {
      const db = getDb();
      const includeTasks = options?.includeTasks ?? false;

      let query: string;
      let params: any[];

      if (parentId === undefined || parentId === null) {
        // Root pages
        query = includeTasks
          ? `SELECT * FROM pages WHERE parentId IS NULL ORDER BY "order" ASC`
          : `SELECT * FROM pages WHERE parentId IS NULL AND task = 0 ORDER BY "order" ASC`;
        params = [];
      } else {
        query = includeTasks
          ? `SELECT * FROM pages WHERE parentId = ? ORDER BY "order" ASC`
          : `SELECT * FROM pages WHERE parentId = ? AND task = 0 ORDER BY "order" ASC`;
        params = [parentId];
      }

      const rows = db.prepare(query).all(...params) as any[];

      return rows.map((row) => ({
        id: row.id,
        title: row.title ?? "",
        autoTitle: !!row.autoTitle,
        parentId: row.parentId,
        order: row.order,
        hasChildren: hasChildren(db, row.id),
        task: !!row.task,
        color: row.color ?? resolveColor(db, row.id),
        scheduledAt: row.scheduledAt ? String(row.scheduledAt) : null,
        duration: row.duration,
        allDay: row.allDay != null ? !!row.allDay : null,
        recurrenceId: row.recurrenceId,
      }));
    },
  );

  // ── Get single page ────────────────────────────────────────────────────

  ipcMain.handle("pages:get", (_, id: string) => {
    const db = getDb();
    const row = db.prepare("SELECT * FROM pages WHERE id = ?").get(id) as any;
    if (!row) throw new Error(`Page not found: ${id}`);

    // Get latest snapshot
    const snapshot = db
      .prepare(
        "SELECT * FROM snapshots WHERE pageId = ? ORDER BY createdAt DESC LIMIT 1",
      )
      .get(id) as any;

    const parents = getAncestorPath(db, row.parentId);

    return {
      id: row.id,
      title: row.title ?? "",
      autoTitle: !!row.autoTitle,
      parentId: row.parentId,
      order: row.order,
      hasChildren: hasChildren(db, row.id),
      task: !!row.task,
      color: row.color ?? resolveColor(db, row.id),
      scheduledAt: row.scheduledAt ? String(row.scheduledAt) : null,
      duration: row.duration,
      allDay: row.allDay != null ? !!row.allDay : null,
      recurrenceId: row.recurrenceId,
      snapshot: snapshot ? JSON.parse(snapshot.data) : null,
      snapshotClock: snapshot?.clockCounter != null
        ? { counter: snapshot.clockCounter, peerId: snapshot.clockPeerId }
        : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      parents,
    };
  });

  // ── Create page ────────────────────────────────────────────────────────

  ipcMain.handle(
    "pages:create",
    (
      _,
      data: {
        title: string;
        parentId: string | null;
        scheduledAt?: string;
        duration?: number;
        allDay?: boolean;
        task?: boolean;
      },
    ) => {
      const db = getDb();
      const id = createId();
      const timestamp = now();

      // Calculate order: max order of siblings + 1
      const maxOrder = (
        data.parentId
          ? db
              .prepare(`SELECT MAX("order") as m FROM pages WHERE parentId = ?`)
              .get(data.parentId)
          : db
              .prepare(`SELECT MAX("order") as m FROM pages WHERE parentId IS NULL`)
              .get()
      ) as { m: number | null };

      const order = (maxOrder?.m ?? -1) + 1;

      db.prepare(
        `INSERT INTO pages (id, title, parentId, "order", scheduledAt, duration, allDay, task, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        data.title || null,
        data.parentId,
        order,
        data.scheduledAt ? Number(data.scheduledAt) : null,
        data.duration ?? null,
        data.allDay != null ? (data.allDay ? 1 : 0) : null,
        data.task ? 1 : 0,
        timestamp,
        timestamp,
      );

      // Create initial snapshot with empty heading block
      const snapshotId = createId();
      const initialBlocks = [
        {
          id: createId(),
          type: "heading1",
          charRuns: [],
          formats: [],
        },
      ];
      const snapshotData = JSON.stringify(initialBlocks);

      db.prepare(
        `INSERT INTO snapshots (id, pageId, data, size, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(snapshotId, id, snapshotData, snapshotData.length, timestamp, timestamp);

      emitPageEvent("onPageCreated", {
        id,
        title: data.title || null,
        parentId: data.parentId,
        order,
      });

      return {
        id,
        title: data.title || "",
        autoTitle: true,
        parentId: data.parentId,
        order,
        hasChildren: false,
        task: !!data.task,
        color: null,
        scheduledAt: data.scheduledAt ?? null,
        duration: data.duration ?? null,
        allDay: data.allDay ?? null,
        recurrenceId: null,
        snapshot: initialBlocks,
        snapshotClock: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        parents: data.parentId ? getAncestorPath(db, data.parentId) : [],
      };
    },
  );

  // ── Update page ────────────────────────────────────────────────────────

  ipcMain.handle(
    "pages:update",
    (
      _,
      data: {
        id: string;
        title?: string;
        autoTitle?: boolean;
        color?: string | null;
        snapshot?: any[];
        snapshotClock?: { counter: number; peerId: string } | null;
        scheduledAt?: string | null;
        duration?: number | null;
        allDay?: boolean | null;
        task?: boolean;
      },
    ) => {
      const db = getDb();
      const timestamp = now();

      // Build dynamic update
      const sets: string[] = ['updatedAt = ?'];
      const params: any[] = [timestamp];

      if (data.title !== undefined) {
        sets.push("title = ?");
        params.push(data.title);
      }
      if (data.autoTitle !== undefined) {
        sets.push("autoTitle = ?");
        params.push(data.autoTitle ? 1 : 0);
      }
      if (data.color !== undefined) {
        sets.push("color = ?");
        params.push(data.color);
      }
      if (data.scheduledAt !== undefined) {
        sets.push("scheduledAt = ?");
        params.push(
          data.scheduledAt != null ? Number(data.scheduledAt) : null,
        );
      }
      if (data.duration !== undefined) {
        sets.push("duration = ?");
        params.push(data.duration);
      }
      if (data.allDay !== undefined) {
        sets.push("allDay = ?");
        params.push(data.allDay != null ? (data.allDay ? 1 : 0) : null);
      }
      if (data.task !== undefined) {
        // Don't allow task=true if page has children
        if (data.task && hasChildren(db, data.id)) {
          throw new Error("Cannot set task on a page with children");
        }
        sets.push("task = ?");
        params.push(data.task ? 1 : 0);
      }

      params.push(data.id);
      db.prepare(`UPDATE pages SET ${sets.join(", ")} WHERE id = ?`).run(
        ...params,
      );

      // Save snapshot if provided
      if (data.snapshot) {
        const snapshotId = createId();
        const snapshotData = JSON.stringify(data.snapshot);

        db.prepare(
          `INSERT INTO snapshots (id, pageId, data, size, clockCounter, clockPeerId, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          snapshotId,
          data.id,
          snapshotData,
          snapshotData.length,
          data.snapshotClock?.counter ?? null,
          data.snapshotClock?.peerId ?? null,
          timestamp,
          timestamp,
        );

        pruneSnapshots(db, data.id);
      }

      // Emit title update event
      if (data.title !== undefined) {
        emitPageEvent("onPageTitleUpdated", data.id, data.title);
      }

      // Re-fetch and return updated page
      const updated = db
        .prepare("SELECT * FROM pages WHERE id = ?")
        .get(data.id) as any;

      const latestSnapshot = db
        .prepare(
          "SELECT * FROM snapshots WHERE pageId = ? ORDER BY createdAt DESC LIMIT 1",
        )
        .get(data.id) as any;

      const parents = getAncestorPath(db, updated.parentId);

      return {
        id: updated.id,
        title: updated.title ?? "",
        autoTitle: !!updated.autoTitle,
        parentId: updated.parentId,
        order: updated.order,
        hasChildren: hasChildren(db, updated.id),
        task: !!updated.task,
        color: updated.color ?? resolveColor(db, updated.id),
        scheduledAt: updated.scheduledAt ? String(updated.scheduledAt) : null,
        duration: updated.duration,
        allDay: updated.allDay != null ? !!updated.allDay : null,
        recurrenceId: updated.recurrenceId,
        snapshot: latestSnapshot ? JSON.parse(latestSnapshot.data) : null,
        snapshotClock:
          latestSnapshot?.clockCounter != null
            ? { counter: latestSnapshot.clockCounter, peerId: latestSnapshot.clockPeerId }
            : null,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        parents,
      };
    },
  );

  // ── Delete page ────────────────────────────────────────────────────────

  ipcMain.handle("pages:delete", (_, id: string) => {
    const db = getDb();

    const descendantIds = getDescendantIds(db, id);
    const allIds = [id, ...descendantIds];

    const deleteSnapshots = db.prepare(
      "DELETE FROM snapshots WHERE pageId = ?",
    );
    const deleteOps = db.prepare("DELETE FROM ops WHERE pageId = ?");
    const deletePage = db.prepare("DELETE FROM pages WHERE id = ?");

    const tx = db.transaction(() => {
      for (const pid of allIds) {
        deleteSnapshots.run(pid);
        deleteOps.run(pid);
        deletePage.run(pid);
      }
    });
    tx();

    emitPageEvent("onPageDeleted", id);
  });

  // ── Move page ──────────────────────────────────────────────────────────

  ipcMain.handle(
    "pages:move",
    (_, data: { id: string; parentId: string | null; order?: number }) => {
      const db = getDb();

      // Prevent circular reference
      if (data.parentId) {
        const ancestors = getAncestorPath(db, data.parentId);
        if (ancestors.some((a) => a.id === data.id)) {
          throw new Error("Cannot move a page into its own descendant");
        }
      }

      const page = db
        .prepare("SELECT parentId, \"order\" FROM pages WHERE id = ?")
        .get(data.id) as any;
      if (!page) throw new Error(`Page not found: ${data.id}`);

      const oldParentId = page.parentId;
      const timestamp = now();

      // Calculate order in new location
      let newOrder = data.order;
      if (newOrder === undefined) {
        const maxOrder = (
          data.parentId
            ? db
                .prepare(`SELECT MAX("order") as m FROM pages WHERE parentId = ?`)
                .get(data.parentId)
            : db
                .prepare(`SELECT MAX("order") as m FROM pages WHERE parentId IS NULL`)
                .get()
        ) as { m: number | null };
        newOrder = (maxOrder?.m ?? -1) + 1;
      }

      db.prepare(
        `UPDATE pages SET parentId = ?, "order" = ?, updatedAt = ? WHERE id = ?`,
      ).run(data.parentId, newOrder, timestamp, data.id);

      emitPageEvent("onPageMoved", data.id, oldParentId, data.parentId);
    },
  );

  // ── Reorder page ───────────────────────────────────────────────────────

  ipcMain.handle("pages:reorder", (_, id: string, order: number) => {
    const db = getDb();
    const timestamp = now();

    const page = db
      .prepare("SELECT parentId FROM pages WHERE id = ?")
      .get(id) as any;
    if (!page) throw new Error(`Page not found: ${id}`);

    db.prepare(`UPDATE pages SET "order" = ?, updatedAt = ? WHERE id = ?`).run(
      order,
      timestamp,
      id,
    );

    emitPageEvent("onPageReordered", id, page.parentId, order);
  });

  // ── Search pages ───────────────────────────────────────────────────────

  ipcMain.handle("pages:search", (_, query: string) => {
    const db = getDb();

    if (!query.trim()) return [];

    const rows = db
      .prepare(
        `SELECT id, title, parentId, color FROM pages
         WHERE title LIKE ? COLLATE NOCASE
         LIMIT 50`,
      )
      .all(`%${query}%`) as any[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      parentId: row.parentId,
      path: row.parentId ? getAncestorPath(db, row.parentId) : null,
      color: row.color ?? resolveColor(db, row.id),
    }));
  });

  // ── Calendar range ─────────────────────────────────────────────────────

  ipcMain.handle("pages:calendar", (_, start: number, end: number) => {
    const db = getDb();

    const rows = db
      .prepare(
        `SELECT * FROM pages
         WHERE scheduledAt IS NOT NULL
         AND scheduledAt >= ? AND scheduledAt <= ?
         AND task = 0
         ORDER BY scheduledAt ASC`,
      )
      .all(start, end) as any[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? "",
      autoTitle: !!row.autoTitle,
      parentId: row.parentId,
      order: row.order,
      color: row.color ?? resolveColor(db, row.id),
      scheduledAt: new Date(Number(row.scheduledAt)).toISOString(),
      duration: row.duration,
      allDay: row.allDay != null ? !!row.allDay : null,
      recurrenceId: row.recurrenceId,
      task: !!row.task,
      path: row.parentId ? getAncestorPath(db, row.parentId) : null,
      createdAt: row.createdAt,
    }));
  });

  // ── Snapshots (version history) ────────────────────────────────────────

  ipcMain.handle("pages:snapshots", (_, pageId: string) => {
    const db = getDb();

    // All snapshots except the latest (current state)
    const rows = db
      .prepare(
        `SELECT * FROM snapshots
         WHERE pageId = ?
         ORDER BY createdAt DESC
         LIMIT -1 OFFSET 1`,
      )
      .all(pageId) as any[];

    return rows.map((row) => ({
      id: row.id,
      pageId: row.pageId,
      blocks: JSON.parse(row.data),
      size: row.size,
      clock:
        row.clockCounter != null
          ? { counter: row.clockCounter, peerId: row.clockPeerId }
          : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  });
}
