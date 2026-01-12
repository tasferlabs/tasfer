import { Router } from "express";
import { createId } from "@paralleldrive/cuid2";
import db from "../db/index";
import { pages, operations, snapshots } from "../db/schema";
import { eq, and, or, isNull, sql, asc, gt, inArray } from "drizzle-orm";
import { encodeSnapshot, decodeSnapshot, type Block } from "../lib/snapshot";
import { writeFile, readFile, deleteFile } from "../handlers/files";

const router = Router();

// List pages
router.get("/list", async (req, res) => {
  try {
    const { parentId } = req.query;

    // Get pages with optional parent filter
    const pagesList = await db
      .select({
        id: pages.id,
        title: pages.title,
        parentId: pages.parentId,
        order: pages.order,
        createdAt: pages.createdAt,
        hasChildren: sql<boolean>`CASE WHEN EXISTS (
          SELECT 1 FROM pages p2 
          WHERE p2."parentId" = pages.id
        ) THEN true ELSE false END`,
      })
      .from(pages)
      .where(
        parentId
          ? eq(pages.parentId, parentId as string)
          : isNull(pages.parentId)
      )
      .orderBy(pages.order, pages.title);

    res.json({ success: true, data: pagesList });
  } catch (error) {
    console.error("List pages error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Get single page
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, id),
    });

    if (!page) {
      return res.status(404).json({ success: false, error: "Page not found" });
    }

    // Get parent hierarchy
    const parentsResult = await db.execute(sql`
      WITH RECURSIVE parent_pages AS (
        SELECT id, title, "parentId", 1 AS depth
        FROM ${pages}
        WHERE id = ${id}

        UNION ALL

        SELECT p.id, p.title, p."parentId", pp.depth + 1
        FROM ${pages} p
        INNER JOIN parent_pages pp ON p.id = pp."parentId"
        WHERE pp.depth < 10
      )
      SELECT id, title FROM parent_pages ORDER BY depth DESC
    `);

    // Load snapshot from file
    let snapshotBlocks: Block[] = [];
    const snapshotRecord = await db.query.snapshots.findFirst({
      where: eq(snapshots.pageId, id),
    });

    if (snapshotRecord) {
      const compressedBuffer = await readFile(snapshotRecord.filePath, {
        bucketName: "snapshots",
      });
      if (compressedBuffer) {
        snapshotBlocks = decodeSnapshot(compressedBuffer);
      }
    }

    // Load operations AFTER the snapshot clock (operations not yet in snapshot)
    // Operations at or before snapshot clock are already included in the snapshot
    let opsQuery = db
      .select()
      .from(operations)
      .where(eq(operations.pageId, id));

    // Filter to only return operations after the snapshot clock
    if (snapshotRecord?.clockWall !== null && snapshotRecord?.clockWall !== undefined) {
      opsQuery = db
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.pageId, id),
            sql`(
              ${operations.clockWall} > ${snapshotRecord.clockWall} OR
              (${operations.clockWall} = ${snapshotRecord.clockWall} AND ${operations.clockLogical} > ${snapshotRecord.clockLogical}) OR
              (${operations.clockWall} = ${snapshotRecord.clockWall} AND ${operations.clockLogical} = ${snapshotRecord.clockLogical} AND ${operations.clockPeerId} > ${snapshotRecord.clockPeerId})
            )`
          )
        );
    }

    const ops = await opsQuery.orderBy(
      asc(operations.clockWall),
      asc(operations.clockLogical),
      asc(operations.clockPeerId)
    );

    // Reconstruct operations in the format expected by the client
    const reconstructedOps = ops.map((row) => ({
      id: row.id,
      op: row.op,
      pageId: row.pageId,
      clock: {
        wall: row.clockWall,
        logical: row.clockLogical,
        peerId: row.clockPeerId,
      },
      ...(row.payload as object),
    }));

    // Include snapshot clock in response for client-side delta tracking
    const snapshotClock = snapshotRecord?.clockWall !== null && snapshotRecord?.clockWall !== undefined
      ? {
          wall: snapshotRecord.clockWall,
          logical: snapshotRecord.clockLogical!,
          peerId: snapshotRecord.clockPeerId!,
        }
      : null;

    res.json({
      success: true,
      data: {
        id: page.id,
        title: page.title,
        parentId: page.parentId,
        order: page.order,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
        snapshot: snapshotBlocks,
        snapshotClock, // Client uses this to track which operations are already saved
        operations: JSON.stringify(reconstructedOps),
        parents: parentsResult.rows,
      },
    });
  } catch (error) {
    console.error("Get page error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Create page
router.post("/create", async (req, res) => {
  try {
    const { title, parentId } = req.body;

    // Validate title is a string if provided
    if (title !== undefined && typeof title !== "string") {
      return res
        .status(400)
        .json({ success: false, error: "Title must be a string" });
    }

    // Get max order for siblings
    const maxOrderResult = await db
      .select({ maxOrder: sql<number>`MAX(${pages.order})` })
      .from(pages)
      .where(parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId));

    const maxOrder = maxOrderResult[0]?.maxOrder ?? -1;

    const pageId = createId();

    const newPage = await db
      .insert(pages)
      .values({
        id: pageId,
        title: title,
        parentId: parentId || null,
        order: maxOrder + 1,
      })
      .returning();

    // Create initial snapshot with empty heading1 block
    const initialSnapshot: Block[] = [
      {
        id: createId(),
        type: "heading1",
        chars: [],
        formats: [],
      },
    ];
    const compressed = encodeSnapshot(initialSnapshot);
    const filePath = `${pageId}.bin`;

    await writeFile(compressed, filePath, { bucketName: "snapshots" });

    // Create snapshot record
    await db.insert(snapshots).values({
      id: createId(),
      pageId: pageId,
      filePath: filePath,
      size: compressed.length,
    });

    res.json({
      success: true,
      data: {
        ...newPage[0],
        snapshot: initialSnapshot,
      },
    });
  } catch (error) {
    console.error("Create page error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Update page
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, snapshot: snapshotBlocks, operations: operationsJson } = req.body;

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, id),
    });

    if (!page) {
      return res.status(404).json({ success: false, error: "Page not found" });
    }

    // Update page metadata
    const updated = await db
      .update(pages)
      .set({
        title: title || page.title,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, id))
      .returning();

    // Parse operations to find the latest clock
    type OpType = "text_insert" | "text_delete" | "format_set" | "block_insert" | "block_delete" | "block_set";
    let latestClock: { wall: number; logical: number; peerId: string } | null = null;
    let parsedOps: Array<{
      id: string;
      op: OpType;
      pageId: string;
      clock: { wall: number; logical: number; peerId: string };
      [key: string]: unknown;
    }> = [];

    if (operationsJson) {
      parsedOps = JSON.parse(operationsJson);

      // Find the latest clock (for snapshot tracking)
      for (const op of parsedOps) {
        if (!latestClock ||
            op.clock.wall > latestClock.wall ||
            (op.clock.wall === latestClock.wall && op.clock.logical > latestClock.logical) ||
            (op.clock.wall === latestClock.wall && op.clock.logical === latestClock.logical && op.clock.peerId > latestClock.peerId)) {
          latestClock = op.clock;
        }
      }
    }

    // Save snapshot to file with clock tracking
    if (snapshotBlocks && Array.isArray(snapshotBlocks)) {
      const compressed = encodeSnapshot(snapshotBlocks as Block[]);
      const filePath = `${id}.bin`;

      await writeFile(compressed, filePath, { bucketName: "snapshots" });

      // Upsert snapshot record with clock
      const existingSnapshot = await db.query.snapshots.findFirst({
        where: eq(snapshots.pageId, id),
      });

      const snapshotData = {
        filePath: filePath,
        size: compressed.length,
        updatedAt: new Date(),
        // Track the latest operation clock included in this snapshot
        ...(latestClock && {
          clockWall: latestClock.wall,
          clockLogical: latestClock.logical,
          clockPeerId: latestClock.peerId,
        }),
      };

      if (existingSnapshot) {
        await db
          .update(snapshots)
          .set(snapshotData)
          .where(eq(snapshots.pageId, id));

        // Garbage collect: delete operations that are now in the snapshot
        // Only delete if we have a valid clock to compare against
        if (latestClock) {
          await db.delete(operations).where(
            and(
              eq(operations.pageId, id),
              sql`(
                ${operations.clockWall} < ${latestClock.wall} OR
                (${operations.clockWall} = ${latestClock.wall} AND ${operations.clockLogical} < ${latestClock.logical}) OR
                (${operations.clockWall} = ${latestClock.wall} AND ${operations.clockLogical} = ${latestClock.logical} AND ${operations.clockPeerId} <= ${latestClock.peerId})
              )`
            )
          );
        }
      } else {
        await db.insert(snapshots).values({
          id: createId(),
          pageId: id,
          ...snapshotData,
        });
      }
    }

    // Save only NEW operations (operations after the snapshot clock)
    // Client should only send delta operations, but we filter server-side for safety
    if (parsedOps.length > 0) {
      // Get current snapshot clock
      const snapshotRecord = await db.query.snapshots.findFirst({
        where: eq(snapshots.pageId, id),
      });

      // Filter to only operations after the snapshot clock
      const newOps = snapshotRecord?.clockWall
        ? parsedOps.filter(op => {
            const snapshotClock = {
              wall: snapshotRecord.clockWall!,
              logical: snapshotRecord.clockLogical!,
              peerId: snapshotRecord.clockPeerId!,
            };
            return (
              op.clock.wall > snapshotClock.wall ||
              (op.clock.wall === snapshotClock.wall && op.clock.logical > snapshotClock.logical) ||
              (op.clock.wall === snapshotClock.wall && op.clock.logical === snapshotClock.logical && op.clock.peerId > snapshotClock.peerId)
            );
          })
        : parsedOps;

      if (newOps.length > 0) {
        const rows = newOps.map((op) => {
          const { id: opId, op: opType, pageId: opPageId, clock, ...payload } = op;
          return {
            id: opId,
            pageId: opPageId,
            op: opType,
            clockWall: clock.wall,
            clockLogical: clock.logical,
            clockPeerId: clock.peerId,
            payload,
          };
        });

        // Upsert operations (insert or ignore if exists)
        await db
          .insert(operations)
          .values(rows)
          .onConflictDoNothing({ target: operations.id });
      }
    }

    res.json({ success: true, data: updated[0] });
  } catch (error) {
    console.error("Update page error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Delete page (and all children recursively)
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, id),
    });

    if (!page) {
      return res.status(404).json({ success: false, error: "Page not found" });
    }

    // Get all page IDs to delete (including children)
    const childPagesResult = await db.execute(sql`
      WITH RECURSIVE child_pages AS (
        SELECT id FROM ${pages} WHERE id = ${id}
        UNION ALL
        SELECT p.id FROM ${pages} p
        INNER JOIN child_pages cp ON cp.id = p."parentId"
      )
      SELECT id FROM child_pages
    `);

    const pageIds = childPagesResult.rows.map((row: { id: string }) => row.id);

    // Delete operations for all pages being deleted
    if (pageIds.length > 0) {
      await db.delete(operations).where(inArray(operations.pageId, pageIds));
    }

    // Delete snapshots for all pages being deleted
    if (pageIds.length > 0) {
      const snapshotRecords = await db
        .select()
        .from(snapshots)
        .where(inArray(snapshots.pageId, pageIds));

      // Delete snapshot files
      for (const snapshot of snapshotRecords) {
        try {
          await deleteFile(snapshot.filePath, { bucketName: "snapshots" });
        } catch (err) {
          console.error(`Failed to delete snapshot file ${snapshot.filePath}:`, err);
        }
      }

      // Delete snapshot records
      await db.delete(snapshots).where(inArray(snapshots.pageId, pageIds));
    }

    // Delete pages
    await db.execute(sql`
      WITH RECURSIVE child_pages AS (
        SELECT id FROM ${pages} WHERE id = ${id}
        UNION ALL
        SELECT p.id FROM ${pages} p
        INNER JOIN child_pages cp ON cp.id = p."parentId"
      )
      DELETE FROM ${pages} WHERE id IN (SELECT id FROM child_pages)
    `);

    res.json({ success: true, message: "Page deleted" });
  } catch (error) {
    console.error("Delete page error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Move page to new parent
router.post("/:id/move", async (req, res) => {
  try {
    const { id } = req.params;
    const { parentId, order } = req.body;

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, id),
    });

    if (!page) {
      return res.status(404).json({ success: false, error: "Page not found" });
    }

    // Prevent moving a page to itself
    if (id === parentId) {
      return res.status(400).json({ 
        success: false, 
        error: "Cannot move a page to itself" 
      });
    }

    // Prevent circular reference: Check if the new parent is a descendant of the page being moved
    if (parentId) {
      const descendantsCheck = await db.execute(sql`
        WITH RECURSIVE child_pages AS (
          SELECT id FROM ${pages} WHERE id = ${id}
          UNION ALL
          SELECT p.id FROM ${pages} p
          INNER JOIN child_pages cp ON cp.id = p."parentId"
        )
        SELECT EXISTS(SELECT 1 FROM child_pages WHERE id = ${parentId}) AS "isDescendant"
      `);
      
      const isDescendant = descendantsCheck.rows[0]?.isDescendant;
      
      if (isDescendant) {
        return res.status(400).json({ 
          success: false, 
          error: "Cannot move a page into its own descendant" 
        });
      }
    }

    // Get max order in new parent
    const maxOrderResult = await db
      .select({ maxOrder: sql<number>`MAX(${pages.order})` })
      .from(pages)
      .where(parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId));

    const maxOrder = maxOrderResult[0]?.maxOrder ?? -1;
    const newOrder = typeof order === "number" ? order : maxOrder + 1;

    // Update page
    await db
      .update(pages)
      .set({
        parentId: parentId || null,
        order: newOrder,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, id));

    // Reorder siblings
    await db.execute(
      parentId
        ? sql`
          WITH "OrderedUpdates" AS (
            SELECT
              id,
              row_number() OVER (ORDER BY "order", title) - 1 AS new_order
            FROM ${pages}
            WHERE "parentId" = ${parentId}
          )
          UPDATE ${pages}
          SET "order" = new_order
          FROM "OrderedUpdates"
          WHERE ${pages.id} = "OrderedUpdates".id
        `
        : sql`
          WITH "OrderedUpdates" AS (
            SELECT
              id,
              row_number() OVER (ORDER BY "order", title) - 1 AS new_order
            FROM ${pages}
            WHERE "parentId" IS NULL
          )
          UPDATE ${pages}
          SET "order" = new_order
          FROM "OrderedUpdates"
          WHERE ${pages.id} = "OrderedUpdates".id
        `
    );

    res.json({ success: true, message: "Page moved" });
  } catch (error) {
    console.error("Move page error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Reorder page
router.post("/:id/reorder", async (req, res) => {
  try {
    const { id } = req.params;
    const { order } = req.body;

    if (typeof order !== "number") {
      return res
        .status(400)
        .json({ success: false, error: "Order must be a number" });
    }

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, id),
    });

    if (!page) {
      return res.status(404).json({ success: false, error: "Page not found" });
    }

    const original = page.order;
    const target = order;

    if (original < target) {
      // Moving down: decrement orders between original and target
      await db
        .update(pages)
        .set({ order: sql`${pages.order} - 1` })
        .where(
          and(
            page.parentId
              ? eq(pages.parentId, page.parentId)
              : isNull(pages.parentId),
            sql`${pages.order} <= ${target}`,
            sql`${pages.order} > ${original}`,
            sql`${pages.id} != ${id}`
          )
        );
    } else {
      // Moving up: increment orders between target and original
      await db
        .update(pages)
        .set({ order: sql`${pages.order} + 1` })
        .where(
          and(
            page.parentId
              ? eq(pages.parentId, page.parentId)
              : isNull(pages.parentId),
            sql`${pages.order} >= ${target}`,
            sql`${pages.order} < ${original}`,
            sql`${pages.id} != ${id}`
          )
        );
    }

    // Update the target page
    await db
      .update(pages)
      .set({ order: target, updatedAt: new Date() })
      .where(eq(pages.id, id));

    res.json({ success: true, message: "Page reordered" });
  } catch (error) {
    console.error("Reorder page error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Get page tree
router.get("/tree/all", async (req, res) => {
  try {
    const allPages = await db.query.pages.findMany({
      orderBy: [pages.order, pages.title],
    });

    // Build tree structure
    const pageMap = new Map();
    const rootPages: any[] = [];

    // First pass: create map
    allPages.forEach((page) => {
      pageMap.set(page.id, { ...page, children: [] });
    });

    // Second pass: build tree
    allPages.forEach((page) => {
      const pageWithChildren = pageMap.get(page.id);
      if (page.parentId) {
        const parent = pageMap.get(page.parentId);
        if (parent) {
          parent.children.push(pageWithChildren);
        }
      } else {
        rootPages.push(pageWithChildren);
      }
    });

    res.json({ success: true, data: rootPages });
  } catch (error) {
    console.error("Get tree error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Get operations for delta sync (operations after a certain clock)
router.get("/:id/operations", async (req, res) => {
  try {
    const { id } = req.params;
    const { afterWall, afterLogical, afterPeerId } = req.query;

    // Base query for page operations
    let query = db
      .select()
      .from(operations)
      .where(eq(operations.pageId, id));

    // If clock params provided, filter for operations after that clock
    if (afterWall && afterLogical && afterPeerId) {
      const wall = Number(afterWall);
      const logical = Number(afterLogical);
      const peerId = String(afterPeerId);

      // Operations with greater HLC: (wall > afterWall) OR
      // (wall == afterWall AND logical > afterLogical) OR
      // (wall == afterWall AND logical == afterLogical AND peerId > afterPeerId)
      query = db
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.pageId, id),
            sql`(
              ${operations.clockWall} > ${wall} OR
              (${operations.clockWall} = ${wall} AND ${operations.clockLogical} > ${logical}) OR
              (${operations.clockWall} = ${wall} AND ${operations.clockLogical} = ${logical} AND ${operations.clockPeerId} > ${peerId})
            )`
          )
        );
    }

    const ops = await query.orderBy(
      asc(operations.clockWall),
      asc(operations.clockLogical),
      asc(operations.clockPeerId)
    );

    // Reconstruct operations
    const reconstructedOps = ops.map((row) => ({
      id: row.id,
      op: row.op,
      pageId: row.pageId,
      clock: {
        wall: row.clockWall,
        logical: row.clockLogical,
        peerId: row.clockPeerId,
      },
      ...(row.payload as object),
    }));

    res.json({ success: true, data: reconstructedOps });
  } catch (error) {
    console.error("Get operations error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
