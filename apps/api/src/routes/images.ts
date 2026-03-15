import { Router, Request } from "express";
import { createId } from "@paralleldrive/cuid2";
import multer from "multer";
import path from "path";
import sharp from "sharp";
import { writeFile, readFile, deleteFile } from "../handlers/files.js";
import db from "../db/index.js";
import { images, pages, snapshots, spaceMembers, spaces, users } from "../db/schema.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
import { decodeSnapshot } from "../lib/snapshot.js";
import { getAccessibleSpaces } from "../lib/permissions.js";

const MAX_IMAGE_DIMENSION = 2000;

async function compressImage(
  buffer: Buffer,
  mimetype: string
): Promise<{ buffer: Buffer; mimetype: string; ext: string }> {
  // Skip SVGs — they're already lightweight
  if (mimetype === "image/svg+xml") {
    return { buffer, mimetype, ext: ".svg" };
  }

  // Skip GIFs to preserve animation
  if (mimetype === "image/gif") {
    return { buffer, mimetype, ext: ".gif" };
  }

  const image = sharp(buffer);
  const metadata = await image.metadata();

  // Resize if larger than max dimension (preserving aspect ratio)
  if (
    (metadata.width && metadata.width > MAX_IMAGE_DIMENSION) ||
    (metadata.height && metadata.height > MAX_IMAGE_DIMENSION)
  ) {
    image.resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  // Strip EXIF/metadata and convert to WebP
  const compressed = await image
    .rotate() // Auto-rotate based on EXIF before stripping
    .webp({ quality: 80 })
    .toBuffer();

  return { buffer: compressed, mimetype: "image/webp", ext: ".webp" };
}

const router = Router();
const IMAGE_URL_PATTERN = /\/api\/images\/([^/?#]+)/;

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept images only
    const allowedMimes = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG images are allowed."));
    }
  },
});

function extractImageId(url: string | undefined | null): string | null {
  if (!url) return null;
  const match = url.match(IMAGE_URL_PATTERN);
  return match ? match[1] : null;
}

function blockReferencesImage(block: any, imageId: string): boolean {
  if (block?.type === "image" && extractImageId(block.url) === imageId) {
    return true;
  }

  if (Array.isArray(block?.charRuns)) {
    return block.charRuns.some(
      (run: { text?: string }) =>
        typeof run.text === "string" &&
        run.text.includes(`/api/images/${imageId}`)
    );
  }

  return false;
}

async function getAccessibleSpaceIds(userId: string): Promise<string[]> {
  const { owned, member } = await getAccessibleSpaces(userId);
  return [...new Set([...owned, ...member].map((space) => space.id))];
}

async function canAccessAvatarImage(
  requesterId: string,
  imageId: string,
  accessibleSpaceIds: string[]
): Promise<boolean> {
  const avatarOwner = await db.query.users.findFirst({
    where: eq(users.avatar, imageId),
    columns: { id: true },
  });

  if (!avatarOwner) return false;
  if (avatarOwner.id === requesterId) return true;
  if (accessibleSpaceIds.length === 0) return false;

  const ownedSharedSpace = await db.query.spaces.findFirst({
    where: and(
      inArray(spaces.id, accessibleSpaceIds),
      eq(spaces.ownerId, avatarOwner.id)
    ),
    columns: { id: true, ownerId: true },
  });
  if (ownedSharedSpace) {
    return true;
  }

  const membership = await db.query.spaceMembers.findFirst({
    where: and(
      inArray(spaceMembers.spaceId, accessibleSpaceIds),
      eq(spaceMembers.userId, avatarOwner.id)
    ),
    columns: { userId: true, spaceId: true },
  });

  return !!membership;
}

async function canAccessPageImage(
  imageId: string,
  accessibleSpaceIds: string[]
): Promise<boolean> {
  if (accessibleSpaceIds.length === 0) return false;

  const accessiblePages = await db
    .select({ id: pages.id })
    .from(pages)
    .where(inArray(pages.spaceId, accessibleSpaceIds));

  const pageIds = accessiblePages.map((page) => page.id);
  if (pageIds.length === 0) return false;

  const snapshotRecords = await db
    .select({ pageId: snapshots.pageId, filePath: snapshots.filePath })
    .from(snapshots)
    .where(inArray(snapshots.pageId, pageIds))
    .orderBy(desc(snapshots.createdAt));

  const seenPages = new Set<string>();
  for (const record of snapshotRecords) {
    if (seenPages.has(record.pageId)) continue;
    seenPages.add(record.pageId);

    const compressedBuffer = await readFile(record.filePath, {
      bucketName: "snapshots",
    });
    if (!compressedBuffer) continue;

    try {
      const blocks = decodeSnapshot(compressedBuffer);
      if (blocks.some((block) => blockReferencesImage(block, imageId))) {
        return true;
      }
    } catch (error) {
      console.error("Failed to inspect snapshot for image authorization:", error);
    }
  }

  return false;
}

async function canReadImage(
  requesterId: string,
  image: typeof images.$inferSelect
): Promise<boolean> {
  if (image.userId === requesterId) {
    return true;
  }

  const accessibleSpaceIds = await getAccessibleSpaceIds(requesterId);

  if (await canAccessAvatarImage(requesterId, image.id, accessibleSpaceIds)) {
    return true;
  }

  return canAccessPageImage(image.id, accessibleSpaceIds);
}

// Upload image (requires auth)
router.post("/upload", requireAuth, upload.single("image"), async (req: Request, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    const file = req.file;
    const imageId = createId();

    // Compress and optimize the image
    const compressed = await compressImage(file.buffer, file.mimetype);
    const fileName = `${imageId}${compressed.ext}`;
    const filePath = `${fileName}`;

    // Write compressed file to storage
    await writeFile(compressed.buffer, filePath, {
      mimetype: compressed.mimetype,
      bucketName: "images",
    });

    // Save metadata to database
    const [newImage] = await db
      .insert(images)
      .values({
        id: imageId,
        userId: req.user!.id,
        fileName: file.originalname,
        filePath: filePath,
        mimeType: compressed.mimetype,
        size: compressed.buffer.length,
      })
      .returning();

    res.json({
      success: true,
      data: {
        id: newImage.id,
        url: `/api/images/${newImage.id}`,
        fileName: newImage.fileName,
        mimeType: newImage.mimeType,
        size: newImage.size,
      },
    });
  } catch (error) {
    console.error("Upload image error:", error);
    res.status(500).json({ success: false, error: "Failed to upload image" });
  }
});

// Get image
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const image = await db.query.images.findFirst({
      where: eq(images.id, id),
    });

    if (!image) {
      return res.status(404).json({ success: false, error: "Image not found" });
    }

    const hasAccess = await canReadImage(req.user!.id, image);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const fileBuffer = await readFile(image.filePath, {
      bucketName: "images",
    });

    if (!fileBuffer) {
      return res.status(404).json({ success: false, error: "Image file not found" });
    }

    res.setHeader("Content-Type", image.mimeType);
    res.setHeader("Cache-Control", "public, max-age=31536000"); // Cache for 1 year
    res.send(fileBuffer);
  } catch (error) {
    console.error("Get image error:", error);
    res.status(500).json({ success: false, error: "Failed to get image" });
  }
});

// Get image metadata
router.get("/:id/info", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const image = await db.query.images.findFirst({
      where: eq(images.id, id),
    });

    if (!image) {
      return res.status(404).json({ success: false, error: "Image not found" });
    }

    const hasAccess = await canReadImage(req.user!.id, image);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    res.json({
      success: true,
      data: {
        id: image.id,
        url: `/api/images/${image.id}`,
        fileName: image.fileName,
        mimeType: image.mimeType,
        size: image.size,
        createdAt: image.createdAt,
      },
    });
  } catch (error) {
    console.error("Get image info error:", error);
    res.status(500).json({ success: false, error: "Failed to get image info" });
  }
});

// Delete image (requires auth)
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const image = await db.query.images.findFirst({
      where: eq(images.id, id),
    });

    if (!image) {
      return res.status(404).json({ success: false, error: "Image not found" });
    }

    if (image.userId !== req.user!.id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    // Delete file from storage
    await deleteFile(image.filePath, {
      bucketName: "images",
    });

    // Delete from database
    await db.delete(images).where(eq(images.id, id));

    res.json({ success: true, message: "Image deleted" });
  } catch (error) {
    console.error("Delete image error:", error);
    res.status(500).json({ success: false, error: "Failed to delete image" });
  }
});

export default router;
