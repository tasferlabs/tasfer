import { Router } from "express";
import { createId } from "@paralleldrive/cuid2";
import db from "../db/index.js";
import { pages, snapshots } from "../db/schema.js";
import { eq, and, isNull, sql, inArray, desc } from "drizzle-orm";
import { encodeSnapshot, decodeSnapshot, type Block } from "../lib/snapshot.js";
import { writeFile, readFile, deleteFile } from "../handlers/files.js";

// Maximum number of snapshots to keep per page
const MAX_SNAPSHOTS_PER_PAGE = 50;

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
        autoTitle: pages.autoTitle,
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

    // Load latest snapshot from file
    let snapshotBlocks: Block[] = [];
    const [snapshotRecord] = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.pageId, id))
      .orderBy(desc(snapshots.createdAt))
      .limit(1);

    if (snapshotRecord) {
      const compressedBuffer = await readFile(snapshotRecord.filePath, {
        bucketName: "snapshots",
      });
      if (compressedBuffer) {
        snapshotBlocks = decodeSnapshot(compressedBuffer);
      }
    }

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
        autoTitle: page.autoTitle,
        parentId: page.parentId,
        order: page.order,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
        snapshot: snapshotBlocks,
        snapshotClock,
        parents: parentsResult.rows,
      },
    });
  } catch (error) {
    console.error("Get page error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Get all snapshots for a page (version history)
router.get("/:id/snapshots", async (req, res) => {
  try {
    const { id } = req.params;

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, id),
    });

    if (!page) {
      return res.status(404).json({ success: false, error: "Page not found" });
    }

    // Get all snapshot records ordered by creation date (newest first)
    // Skip the first one (current state) - users want to restore to previous versions
    const snapshotRecords = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.pageId, id))
      .orderBy(desc(snapshots.createdAt));

    // Skip the most recent snapshot (that's the current state)
    const previousSnapshots = snapshotRecords.slice(1);

    // Load and decode each snapshot
    const snapshotsWithBlocks = await Promise.all(
      previousSnapshots.map(async (record) => {
        try {
          const compressedBuffer = await readFile(record.filePath, {
            bucketName: "snapshots",
          });

          if (!compressedBuffer) {
            return null;
          }

          const blocks = decodeSnapshot(compressedBuffer);

          return {
            id: record.id,
            pageId: record.pageId,
            blocks,
            size: record.size,
            clock: record.clockWall !== null
              ? {
                  wall: record.clockWall,
                  logical: record.clockLogical!,
                  peerId: record.clockPeerId!,
                }
              : null,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          };
        } catch (err) {
          console.error(`Failed to load snapshot ${record.id}:`, err);
          return null;
        }
      })
    );

    // Filter out any failed loads
    const validSnapshots = snapshotsWithBlocks.filter(Boolean);

    res.json({
      success: true,
      data: validSnapshots,
    });
  } catch (error) {
    console.error("Get snapshots error:", error);
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
    const snapshotId = createId();
    const initialSnapshot: Block[] = [
      {
        id: createId(),
        type: "heading1",
        charRuns: [],
        formats: [],
      },
    ];
    const compressed = encodeSnapshot(initialSnapshot);
    // Use unique file path per snapshot version
    const filePath = `${pageId}/${snapshotId}.bin`;

    await writeFile(compressed, filePath, { bucketName: "snapshots" });

    // Create snapshot record
    await db.insert(snapshots).values({
      id: snapshotId,
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
    const { title, autoTitle, snapshot: snapshotBlocks, snapshotClock } = req.body;

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, id),
    });

    if (!page) {
      return res.status(404).json({ success: false, error: "Page not found" });
    }

    // Build update object
    const updateData: { title?: string; autoTitle?: boolean; updatedAt: Date } = {
      updatedAt: new Date(),
    };

    // Update title if provided
    if (title !== undefined) {
      updateData.title = title;
    }

    // Update autoTitle flag if provided
    if (autoTitle !== undefined) {
      updateData.autoTitle = autoTitle;
    }

    // Update page metadata
    const updated = await db
      .update(pages)
      .set(updateData)
      .where(eq(pages.id, id))
      .returning();

    // Save snapshot to file - create new version each time
    if (snapshotBlocks && Array.isArray(snapshotBlocks)) {
      const snapshotId = createId();
      const compressed = encodeSnapshot(snapshotBlocks as Block[]);
      // Use unique file path per snapshot version
      const filePath = `${id}/${snapshotId}.bin`;

      await writeFile(compressed, filePath, { bucketName: "snapshots" });

      // Create new snapshot record
      await db.insert(snapshots).values({
        id: snapshotId,
        pageId: id,
        filePath: filePath,
        size: compressed.length,
        // Track the snapshot clock for delta sync
        ...(snapshotClock && {
          clockWall: snapshotClock.wall,
          clockLogical: snapshotClock.logical,
          clockPeerId: snapshotClock.peerId,
        }),
      });

      // Prune old snapshots if exceeding limit
      const allSnapshots = await db
        .select({ id: snapshots.id, filePath: snapshots.filePath })
        .from(snapshots)
        .where(eq(snapshots.pageId, id))
        .orderBy(desc(snapshots.createdAt));

      if (allSnapshots.length > MAX_SNAPSHOTS_PER_PAGE) {
        const snapshotsToDelete = allSnapshots.slice(MAX_SNAPSHOTS_PER_PAGE);

        // Delete old snapshot files
        for (const snapshot of snapshotsToDelete) {
          try {
            await deleteFile(snapshot.filePath, { bucketName: "snapshots" });
          } catch (err) {
            console.error(`Failed to delete old snapshot file ${snapshot.filePath}:`, err);
          }
        }

        // Delete old snapshot records
        const idsToDelete = snapshotsToDelete.map(s => s.id);
        await db.delete(snapshots).where(inArray(snapshots.id, idsToDelete));
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

export default router;
