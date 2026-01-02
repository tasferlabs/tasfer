import { Router } from "express";
import { createId } from "@paralleldrive/cuid2";
import db from "../db/index";
import { pages } from "../db/schema";
import { eq, and, or, isNull, sql } from "drizzle-orm";

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

    res.json({ success: true, data: { ...page, parents: parentsResult.rows } });
  } catch (error) {
    console.error("Get page error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Create page
router.post("/create", async (req, res) => {
  try {
    const { title, content, parentId } = req.body;

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

    const newPage = await db
      .insert(pages)
      .values({
        id: createId(),
        title: title,
        content: content || null,
        parentId: parentId || null,
        order: maxOrder + 1,
      })
      .returning();

    res.json({ success: true, data: newPage[0] });
  } catch (error) {
    console.error("Create page error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Update page
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content } = req.body;

    const page = await db.query.pages.findFirst({
      where: eq(pages.id, id),
    });

    if (!page) {
      return res.status(404).json({ success: false, error: "Page not found" });
    }

    const updated = await db
      .update(pages)
      .set({
        title: title || page.title,
        content: content !== undefined ? content : page.content,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, id))
      .returning();

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

    // Delete page and all children recursively
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
