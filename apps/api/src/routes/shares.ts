// import { Router } from "express";
// import { createId } from "@paralleldrive/cuid2";
// import { Redis } from "ioredis";
// import db from "../db/index.js";
// import { pageShares, pages, users } from "../db/schema.js";
// import { eq, and } from "drizzle-orm";
// import { canAccessPage, getSharedPages, getSharedByMe } from "../lib/permissions.js";
//
// // =============================================================================
// // Redis Publisher (Share Events)
// // =============================================================================
//
// const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
// const REDIS_CHANNEL = "cypher:share-events";
//
// let redisPublisher: Redis | null = null;
//
// async function getRedisPublisher(): Promise<Redis | null> {
//   if (redisPublisher) return redisPublisher;
//
//   try {
//     redisPublisher = new Redis(REDIS_URL);
//     redisPublisher.on("error", (error: Error) => {
//       console.error("[Shares API] Redis error:", error);
//     });
//     console.log("[Shares API] Connected to Redis for share events");
//     return redisPublisher;
//   } catch (error) {
//     console.error("[Shares API] Failed to connect to Redis:", error);
//     return null;
//   }
// }
//
// // Initialize Redis connection
// getRedisPublisher();
//
// /** Share event types */
// type ShareEvent =
//   | { type: "share-created"; shareId: string; pageId: string; userId: string; permission: string; includeChildren: boolean; pageTitle: string | null; sharedByName: string | null }
//   | { type: "share-updated"; shareId: string; pageId: string; userId: string; permission: string; includeChildren: boolean }
//   | { type: "share-removed"; shareId: string; pageId: string; userId: string };
//
// /**
//  * Publish a share event to Redis.
//  * Fails silently if Redis is not available.
//  */
// async function publishShareEvent(event: ShareEvent): Promise<void> {
//   try {
//     const redis = await getRedisPublisher();
//     if (redis) {
//       await redis.publish(REDIS_CHANNEL, JSON.stringify(event));
//       console.log(`[Shares API] Published event: ${event.type}`);
//     }
//   } catch (error) {
//     console.error("[Shares API] Failed to publish share event:", error);
//   }
// }
//
// const router = Router();
//
// // Get shares for a page
// router.get("/pages/:id/shares", async (req, res) => {
//   try {
//     const { id } = req.params;
//
//     // Verify user has owner-level access
//     const hasAccess = await canAccessPage(req.user!.id, id, "owner");
//     if (!hasAccess) {
//       return res.status(403).json({ success: false, error: "Access denied" });
//     }
//
//     const shares = await db
//       .select({
//         id: pageShares.id,
//         pageId: pageShares.pageId,
//         userId: pageShares.userId,
//         sharedBy: pageShares.sharedBy,
//         permission: pageShares.permission,
//         includeChildren: pageShares.includeChildren,
//         createdAt: pageShares.createdAt,
//         userName: users.name,
//         userEmail: users.email,
//       })
//       .from(pageShares)
//       .innerJoin(users, eq(pageShares.userId, users.id))
//       .where(eq(pageShares.pageId, id));
//
//     res.json({ success: true, data: shares });
//   } catch (error) {
//     console.error("Get page shares error:", error);
//     res.status(500).json({ success: false, error: "Internal server error" });
//   }
// });
//
// // Share a page with a user
// router.post("/pages/:id/shares", async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { email, permission, includeChildren } = req.body;
//
//     // Verify user has owner-level access
//     const hasAccess = await canAccessPage(req.user!.id, id, "owner");
//     if (!hasAccess) {
//       return res.status(403).json({ success: false, error: "Access denied" });
//     }
//
//     if (!email || typeof email !== "string") {
//       return res.status(400).json({ success: false, error: "Email is required" });
//     }
//
//     const sharePermission = permission === "edit" ? "edit" : "view";
//
//     // Find user by email
//     const user = await db.query.users.findFirst({
//       where: eq(users.email, email.toLowerCase().trim()),
//     });
//
//     if (!user) {
//       return res.status(404).json({ success: false, error: "User not found" });
//     }
//
//     // Can't share with yourself
//     if (user.id === req.user!.id) {
//       return res.status(400).json({ success: false, error: "Cannot share with yourself" });
//     }
//
//     // Check if already shared
//     const existing = await db.query.pageShares.findFirst({
//       where: and(
//         eq(pageShares.pageId, id),
//         eq(pageShares.userId, user.id)
//       ),
//     });
//
//     if (existing) {
//       return res.status(409).json({ success: false, error: "Page already shared with this user" });
//     }
//
//     const [newShare] = await db
//       .insert(pageShares)
//       .values({
//         id: createId(),
//         pageId: id,
//         userId: user.id,
//         sharedBy: req.user!.id,
//         permission: sharePermission,
//         includeChildren: includeChildren ?? false,
//       })
//       .returning();
//
//     // Fetch page title and sharer name for the event
//     const page = await db.query.pages.findFirst({
//       where: eq(pages.id, id),
//       columns: { title: true },
//     });
//     const sharer = await db.query.users.findFirst({
//       where: eq(users.id, req.user!.id),
//       columns: { name: true },
//     });
//
//     await publishShareEvent({
//       type: "share-created",
//       shareId: newShare.id,
//       pageId: id,
//       userId: user.id,
//       permission: sharePermission,
//       includeChildren: includeChildren ?? false,
//       pageTitle: page?.title ?? null,
//       sharedByName: sharer?.name ?? null,
//     });
//
//     res.json({
//       success: true,
//       data: {
//         ...newShare,
//         userName: user.name,
//         userEmail: user.email,
//       },
//     });
//   } catch (error) {
//     console.error("Share page error:", error);
//     res.status(500).json({ success: false, error: "Internal server error" });
//   }
// });
//
// // Update share permission
// router.put("/pages/:id/shares/:shareId", async (req, res) => {
//   try {
//     const { id, shareId } = req.params;
//     const { permission, includeChildren } = req.body;
//
//     // Verify user has owner-level access
//     const hasAccess = await canAccessPage(req.user!.id, id, "owner");
//     if (!hasAccess) {
//       return res.status(403).json({ success: false, error: "Access denied" });
//     }
//
//     const share = await db.query.pageShares.findFirst({
//       where: and(
//         eq(pageShares.id, shareId),
//         eq(pageShares.pageId, id)
//       ),
//     });
//
//     if (!share) {
//       return res.status(404).json({ success: false, error: "Share not found" });
//     }
//
//     const updateData: { permission?: string; includeChildren?: boolean } = {};
//     if (permission !== undefined) {
//       updateData.permission = permission === "edit" ? "edit" : "view";
//     }
//     if (includeChildren !== undefined) {
//       updateData.includeChildren = includeChildren;
//     }
//
//     const [updated] = await db
//       .update(pageShares)
//       .set(updateData)
//       .where(eq(pageShares.id, shareId))
//       .returning();
//
//     await publishShareEvent({
//       type: "share-updated",
//       shareId,
//       pageId: id,
//       userId: share.userId,
//       permission: updated.permission,
//       includeChildren: updated.includeChildren,
//     });
//
//     res.json({ success: true, data: updated });
//   } catch (error) {
//     console.error("Update share error:", error);
//     res.status(500).json({ success: false, error: "Internal server error" });
//   }
// });
//
// // Remove share
// router.delete("/pages/:id/shares/:shareId", async (req, res) => {
//   try {
//     const { id, shareId } = req.params;
//
//     // Verify user has owner-level access
//     const hasAccess = await canAccessPage(req.user!.id, id, "owner");
//     if (!hasAccess) {
//       return res.status(403).json({ success: false, error: "Access denied" });
//     }
//
//     const share = await db.query.pageShares.findFirst({
//       where: and(
//         eq(pageShares.id, shareId),
//         eq(pageShares.pageId, id)
//       ),
//     });
//
//     if (!share) {
//       return res.status(404).json({ success: false, error: "Share not found" });
//     }
//
//     await db.delete(pageShares).where(eq(pageShares.id, shareId));
//
//     await publishShareEvent({
//       type: "share-removed",
//       shareId,
//       pageId: id,
//       userId: share.userId,
//     });
//
//     res.json({ success: true, message: "Share removed" });
//   } catch (error) {
//     console.error("Delete share error:", error);
//     res.status(500).json({ success: false, error: "Internal server error" });
//   }
// });
//
// // Get pages shared with the current user
// router.get("/shared-with-me", async (req, res) => {
//   try {
//     const shares = await getSharedPages(req.user!.id);
//     res.json({ success: true, data: shares });
//   } catch (error) {
//     console.error("Get shared pages error:", error);
//     res.status(500).json({ success: false, error: "Internal server error" });
//   }
// });
//
// // Get pages the current user has shared with others
// router.get("/shared-by-me", async (req, res) => {
//   try {
//     const shares = await getSharedByMe(req.user!.id);
//     res.json({ success: true, data: shares });
//   } catch (error) {
//     console.error("Get shared by me error:", error);
//     res.status(500).json({ success: false, error: "Internal server error" });
//   }
// });
//
// export default router;
