import { Router } from "express";
import { createId } from "@paralleldrive/cuid2";
import db from "../db/index.js";
import { spaces, spaceMembers, users, pages, snapshots } from "../db/schema.js";
import { eq, and, inArray, desc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getAccessibleSpaces, canAccessSpace } from "../lib/permissions.js";
import { deleteFile } from "../handlers/files.js";

const router = Router();

// List spaces the user owns or is a member of
router.get("/", async (req, res) => {
  try {
    const result = await getAccessibleSpaces(req.user!.id);

    res.json({
      success: true,
      data: {
        owned: result.owned,
        member: result.member,
      },
    });
  } catch (error) {
    console.error("List spaces error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Create group space
router.post("/", async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ success: false, error: "Name is required" });
    }

    const spaceId = createId();
    const [newSpace] = await db
      .insert(spaces)
      .values({
        id: spaceId,
        name: name.trim(),
        description: typeof description === "string" ? description.slice(0, 500) : "",
        type: "group",
        ownerId: req.user!.id,
      })
      .returning();

    // Add owner as a member too
    await db.insert(spaceMembers).values({
      id: createId(),
      spaceId: spaceId,
      userId: req.user!.id,
      role: "owner",
    });

    res.json({ success: true, data: newSpace });
  } catch (error) {
    console.error("Create space error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Update space name
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.id, id),
    });

    if (!space) {
      return res.status(404).json({ success: false, error: "Space not found" });
    }

    if (space.ownerId !== req.user!.id) {
      return res.status(403).json({ success: false, error: "Only the owner can update the space" });
    }

    if (!name || typeof name !== "string") {
      return res.status(400).json({ success: false, error: "Name is required" });
    }

    const updateData: { name: string; description?: string; updatedAt: Date } = {
      name: name.trim(),
      updatedAt: new Date(),
    };
    if (typeof description === "string") {
      updateData.description = description.slice(0, 500);
    }

    const [updated] = await db
      .update(spaces)
      .set(updateData)
      .where(eq(spaces.id, id))
      .returning();

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error("Update space error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Delete group space
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.id, id),
    });

    if (!space) {
      return res.status(404).json({ success: false, error: "Space not found" });
    }

    if (space.ownerId !== req.user!.id) {
      return res.status(403).json({ success: false, error: "Only the owner can delete the space" });
    }

    if (space.type === "personal") {
      return res.status(400).json({ success: false, error: "Cannot delete personal space" });
    }

    // Delete all pages in the space and their snapshots
    const spacePages = await db
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.spaceId, id));

    const pageIds = spacePages.map((p) => p.id);

    if (pageIds.length > 0) {
      const snapshotRecords = await db
        .select({ id: snapshots.id, filePath: snapshots.filePath })
        .from(snapshots)
        .where(inArray(snapshots.pageId, pageIds));

      for (const snapshot of snapshotRecords) {
        try {
          await deleteFile(snapshot.filePath, { bucketName: "snapshots" });
        } catch (err) {
          console.error(`Failed to delete snapshot file ${snapshot.filePath}:`, err);
        }
      }

      await db.delete(snapshots).where(inArray(snapshots.pageId, pageIds));
      await db.delete(pages).where(eq(pages.spaceId, id));
    }

    // Delete members
    await db.delete(spaceMembers).where(eq(spaceMembers.spaceId, id));

    // Delete space
    await db.delete(spaces).where(eq(spaces.id, id));

    res.json({ success: true, message: "Space deleted" });
  } catch (error) {
    console.error("Delete space error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// List members of a space
router.get("/:id/members", async (req, res) => {
  try {
    const { id } = req.params;

    const hasAccess = await canAccessSpace(req.user!.id, id);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const members = await db
      .select({
        id: spaceMembers.id,
        userId: spaceMembers.userId,
        role: spaceMembers.role,
        createdAt: spaceMembers.createdAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(spaceMembers)
      .innerJoin(users, eq(spaceMembers.userId, users.id))
      .where(eq(spaceMembers.spaceId, id));

    res.json({ success: true, data: members });
  } catch (error) {
    console.error("List members error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Add member to space
router.post("/:id/members", async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.id, id),
    });

    if (!space) {
      return res.status(404).json({ success: false, error: "Space not found" });
    }

    if (space.ownerId !== req.user!.id) {
      return res.status(403).json({ success: false, error: "Only the owner can add members" });
    }

    if (!email || typeof email !== "string") {
      return res.status(400).json({ success: false, error: "Email is required" });
    }

    // Find user by email
    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // Check if already a member
    const existing = await db.query.spaceMembers.findFirst({
      where: and(
        eq(spaceMembers.spaceId, id),
        eq(spaceMembers.userId, user.id)
      ),
    });

    if (existing) {
      return res.status(409).json({ success: false, error: "User is already a member" });
    }

    const [newMember] = await db
      .insert(spaceMembers)
      .values({
        id: createId(),
        spaceId: id,
        userId: user.id,
        role: "editor",
      })
      .returning();

    res.json({
      success: true,
      data: {
        ...newMember,
        userName: user.name,
        userEmail: user.email,
      },
    });
  } catch (error) {
    console.error("Add member error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Remove member from space
router.delete("/:id/members/:memberId", async (req, res) => {
  try {
    const { id, memberId } = req.params;

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.id, id),
    });

    if (!space) {
      return res.status(404).json({ success: false, error: "Space not found" });
    }

    if (space.ownerId !== req.user!.id) {
      return res.status(403).json({ success: false, error: "Only the owner can remove members" });
    }

    const member = await db.query.spaceMembers.findFirst({
      where: and(
        eq(spaceMembers.id, memberId),
        eq(spaceMembers.spaceId, id)
      ),
    });

    if (!member) {
      return res.status(404).json({ success: false, error: "Member not found" });
    }

    // Prevent owner from removing themselves
    if (member.userId === space.ownerId) {
      return res.status(400).json({ success: false, error: "Cannot remove the space owner" });
    }

    await db.delete(spaceMembers).where(eq(spaceMembers.id, memberId));

    res.json({ success: true, message: "Member removed" });
  } catch (error) {
    console.error("Remove member error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Leave group (current user removes themselves)
router.post("/:id/leave", async (req, res) => {
  try {
    const { id } = req.params;

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.id, id),
    });

    if (!space) {
      return res.status(404).json({ success: false, error: "Space not found" });
    }

    if (space.type === "personal") {
      return res.status(400).json({ success: false, error: "Cannot leave personal space" });
    }

    // Owner cannot leave their own space
    if (space.ownerId === req.user!.id) {
      return res.status(400).json({ success: false, error: "Owner cannot leave the space. Transfer ownership or delete the space." });
    }

    const membership = await db.query.spaceMembers.findFirst({
      where: and(
        eq(spaceMembers.spaceId, id),
        eq(spaceMembers.userId, req.user!.id)
      ),
    });

    if (!membership) {
      return res.status(404).json({ success: false, error: "You are not a member of this space" });
    }

    await db.delete(spaceMembers).where(eq(spaceMembers.id, membership.id));

    res.json({ success: true, message: "Left space" });
  } catch (error) {
    console.error("Leave space error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
