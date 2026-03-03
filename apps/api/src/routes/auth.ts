import { Router } from "express";
import { createId } from "@paralleldrive/cuid2";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import db from "../db/index.js";
import { users, spaces, refreshTokens } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requireAuth, signAccessToken } from "../middleware/auth.js";

const REFRESH_TOKEN_EXPIRY_DAYS = 30;

const router = Router();

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createRefreshToken(userId: string, res: any): Promise<void> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(refreshTokens).values({
    id: createId(),
    userId,
    tokenHash,
    expiresAt,
  });

  res.cookie("refreshToken", rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    path: "/api/auth",
  });
}

// Register
router.post("/register", async (req, res) => {
  try {
    const { email, name, password } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({ success: false, error: "Email, name, and password are required" });
    }

    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ success: false, error: "Password must be at least 8 characters" });
    }

    // Check if email already exists
    const existing = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

    if (existing) {
      return res.status(409).json({ success: false, error: "Email already in use" });
    }

    const userId = createId();
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user + personal space in transaction
    const [newUser] = await db.insert(users).values({
      id: userId,
      email: email.toLowerCase().trim(),
      name: name.trim(),
      passwordHash,
    }).returning();

    await db.insert(spaces).values({
      id: createId(),
      name: `${name.trim()}'s Space`,
      type: "personal",
      ownerId: userId,
    });

    const accessToken = signAccessToken({ id: newUser.id, email: newUser.email });
    await createRefreshToken(userId, res);

    res.json({
      success: true,
      data: {
        user: { id: newUser.id, email: newUser.email, name: newUser.name },
        accessToken,
      },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: "Email and password are required" });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ success: false, error: "Invalid email or password" });
    }

    const accessToken = signAccessToken({ id: user.id, email: user.email });
    await createRefreshToken(user.id, res);

    res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        accessToken,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Refresh token
router.post("/refresh", async (req, res) => {
  try {
    const rawToken = req.cookies?.refreshToken;
    if (!rawToken) {
      return res.status(401).json({ success: false, error: "No refresh token" });
    }

    const tokenHash = hashToken(rawToken);
    const storedToken = await db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, tokenHash),
    });

    if (!storedToken || storedToken.expiresAt < new Date()) {
      return res.status(401).json({ success: false, error: "Invalid or expired refresh token" });
    }

    // Delete the used token (rotation)
    await db.delete(refreshTokens).where(eq(refreshTokens.id, storedToken.id));

    const user = await db.query.users.findFirst({
      where: eq(users.id, storedToken.userId),
    });

    if (!user) {
      return res.status(401).json({ success: false, error: "User not found" });
    }

    const accessToken = signAccessToken({ id: user.id, email: user.email });
    await createRefreshToken(user.id, res);

    res.json({
      success: true,
      data: { accessToken },
    });
  } catch (error) {
    console.error("Refresh error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Logout
router.post("/logout", async (req, res) => {
  try {
    const rawToken = req.cookies?.refreshToken;
    if (rawToken) {
      const tokenHash = hashToken(rawToken);
      await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
    }

    res.clearCookie("refreshToken", { path: "/api/auth" });
    res.json({ success: true, message: "Logged out" });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Get current user
router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, req.user!.id),
    });

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name },
      },
    });
  } catch (error) {
    console.error("Get me error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
