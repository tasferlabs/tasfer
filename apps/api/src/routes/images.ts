import { Router, Request } from "express";
import { createId } from "@paralleldrive/cuid2";
import multer from "multer";
import path from "path";
import { writeFile, readFile, deleteFile } from "../handlers/files.js";
import db from "../db/index.js";
import { images } from "../db/schema.js";
import { eq } from "drizzle-orm";

const router = Router();

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

// Upload image
router.post("/upload", upload.single("image"), async (req: Request, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    const file = req.file;
    const imageId = createId();
    const ext = path.extname(file.originalname);
    const fileName = `${imageId}${ext}`;
    const filePath = `${fileName}`;

    // Write file to storage
    await writeFile(file.buffer, filePath, {
      mimetype: file.mimetype,
      bucketName: "images",
    });

    // Save metadata to database
    const [newImage] = await db
      .insert(images)
      .values({
        id: imageId,
        fileName: file.originalname,
        filePath: filePath,
        mimeType: file.mimetype,
        size: file.size,
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
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const image = await db.query.images.findFirst({
      where: eq(images.id, id),
    });

    if (!image) {
      return res.status(404).json({ success: false, error: "Image not found" });
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
router.get("/:id/info", async (req, res) => {
  try {
    const { id } = req.params;

    const image = await db.query.images.findFirst({
      where: eq(images.id, id),
    });

    if (!image) {
      return res.status(404).json({ success: false, error: "Image not found" });
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

// Delete image
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const image = await db.query.images.findFirst({
      where: eq(images.id, id),
    });

    if (!image) {
      return res.status(404).json({ success: false, error: "Image not found" });
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

