import { Router } from "express";
import { createId } from "@paralleldrive/cuid2";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import db from "../db/index.js";
import { users, spaces, refreshTokens } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requireAuth, signAccessToken } from "../middleware/auth.js";
import { sendVerificationEmail, sendPasswordResetEmail, sendEmailChangeVerification } from "../services/email.js";

const REFRESH_TOKEN_EXPIRY_DAYS = 30;
const VERIFICATION_CODE_EXPIRY_MINUTES = 10;

const router = Router();

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateVerificationCode(): string {
  return crypto.randomInt(100000, 999999).toString();
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

async function setVerificationCode(userId: string): Promise<string> {
  const code = generateVerificationCode();
  const codeHash = hashToken(code);
  const expiresAt = new Date(Date.now() + VERIFICATION_CODE_EXPIRY_MINUTES * 60 * 1000);

  await db
    .update(users)
    .set({ verificationCode: codeHash, verificationCodeExpiresAt: expiresAt })
    .where(eq(users.id, userId));

  return code;
}

// Register
router.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: "Email and password are required" });
    }

    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ success: false, error: "Password must be at least 8 characters" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists
    const existing = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });

    if (existing) {
      // If existing user is unverified, allow re-registration with new credentials
      if (!existing.emailVerified) {
        const passwordHash = await bcrypt.hash(password, 12);
        await db
          .update(users)
          .set({ passwordHash })
          .where(eq(users.id, existing.id));

        const code = await setVerificationCode(existing.id);
        await sendVerificationEmail(normalizedEmail, code);

        return res.json({
          success: true,
          data: { needsVerification: true, email: normalizedEmail },
        });
      }
      return res.status(409).json({ success: false, error: "Email already in use" });
    }

    const userId = createId();
    const passwordHash = await bcrypt.hash(password, 12);

    await db.insert(users).values({
      id: userId,
      email: normalizedEmail,
      name: "",
      passwordHash,
    });

    await db.insert(spaces).values({
      id: createId(),
      name: "Personal Space",
      type: "personal",
      ownerId: userId,
    });

    // Send verification email
    const code = await setVerificationCode(userId);
    await sendVerificationEmail(normalizedEmail, code);

    res.json({
      success: true,
      data: { needsVerification: true, email: normalizedEmail },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Verify email
router.post("/verify-email", async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ success: false, error: "Email and code are required" });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

    if (!user) {
      return res.status(400).json({ success: false, error: "Invalid verification code" });
    }

    if (user.emailVerified) {
      return res.status(400).json({ success: false, error: "Email already verified" });
    }

    if (!user.verificationCode || !user.verificationCodeExpiresAt) {
      return res.status(400).json({ success: false, error: "No verification code pending. Please request a new one." });
    }

    if (user.verificationCodeExpiresAt < new Date()) {
      return res.status(400).json({ success: false, error: "Verification code expired. Please request a new one." });
    }

    const codeHash = hashToken(code);
    if (codeHash !== user.verificationCode) {
      return res.status(400).json({ success: false, error: "Invalid verification code" });
    }

    // Mark as verified and clear the code
    await db
      .update(users)
      .set({
        emailVerified: true,
        verificationCode: null,
        verificationCodeExpiresAt: null,
      })
      .where(eq(users.id, user.id));

    // Issue tokens
    const accessToken = signAccessToken({ id: user.id, email: user.email });
    await createRefreshToken(user.id, res);

    res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar },
        accessToken,
      },
    });
  } catch (error) {
    console.error("Verify email error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Resend verification code
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: "Email is required" });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

    if (!user || user.emailVerified) {
      // Don't reveal whether the email exists
      return res.json({ success: true, message: "If the email exists, a new code has been sent." });
    }

    const code = await setVerificationCode(user.id);
    await sendVerificationEmail(user.email, code);

    res.json({ success: true, message: "Verification code sent." });
  } catch (error) {
    console.error("Resend verification error:", error);
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

    // Block unverified users and resend code
    if (!user.emailVerified) {
      const code = await setVerificationCode(user.id);
      await sendVerificationEmail(user.email, code);

      return res.json({
        success: true,
        data: { needsVerification: true, email: user.email },
      });
    }

    const accessToken = signAccessToken({ id: user.id, email: user.email });
    await createRefreshToken(user.id, res);

    res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar },
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
        user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar },
      },
    });
  } catch (error) {
    console.error("Get me error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Update profile
router.put("/profile", requireAuth, async (req, res) => {
  try {
    const { name, avatar } = req.body;
    const updates: Record<string, any> = { updatedAt: new Date() };

    if (name !== undefined) {
      const trimmed = typeof name === "string" ? name.trim() : "";
      if (!trimmed || trimmed.length > 255) {
        return res.status(400).json({ success: false, error: "Name must be between 1 and 255 characters" });
      }
      updates.name = trimmed;
    }

    if (avatar !== undefined) {
      updates.avatar = avatar; // string (image ID) or null to remove
    }

    await db.update(users).set(updates).where(eq(users.id, req.user!.id));

    const user = await db.query.users.findFirst({
      where: eq(users.id, req.user!.id),
    });

    res.json({
      success: true,
      data: {
        user: { id: user!.id, email: user!.email, name: user!.name, avatar: user!.avatar },
      },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ success: false, error: "Failed to update profile" });
  }
});

// Forgot password
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: "Email is required" });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

    // Privacy-safe: always return success
    if (!user || !user.emailVerified) {
      return res.json({ success: true });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_EXPIRY_MINUTES * 60 * 1000);

    await db
      .update(users)
      .set({ verificationCode: tokenHash, verificationCodeExpiresAt: expiresAt })
      .where(eq(users.id, user.id));

    await sendPasswordResetEmail(user.email, token);

    res.json({ success: true });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Reset password (public - token from email link proves identity)
router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ success: false, error: "Token and new password are required" });
    }

    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).json({ success: false, error: "Password must be at least 8 characters" });
    }

    const tokenHash = hashToken(token);

    const user = await db.query.users.findFirst({
      where: eq(users.verificationCode, tokenHash),
    });

    if (!user) {
      return res.status(400).json({ success: false, error: "Invalid or expired link" });
    }

    if (!user.verificationCodeExpiresAt || user.verificationCodeExpiresAt < new Date()) {
      return res.status(400).json({ success: false, error: "This link has expired. Please request a new one." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db
      .update(users)
      .set({
        passwordHash,
        verificationCode: null,
        verificationCodeExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    res.json({ success: true });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Change email (request)
router.post("/change-email", requireAuth, async (req, res) => {
  try {
    const { newEmail } = req.body;

    if (!newEmail || typeof newEmail !== "string") {
      return res.status(400).json({ success: false, error: "New email is required" });
    }

    const normalizedEmail = newEmail.toLowerCase().trim();

    // Get current user
    const user = await db.query.users.findFirst({
      where: eq(users.id, req.user!.id),
    });

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    if (normalizedEmail === user.email) {
      return res.status(400).json({ success: false, error: "New email must be different from current email" });
    }

    // Check if new email is already taken
    const existing = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });

    if (existing) {
      return res.status(409).json({ success: false, error: "Email already in use" });
    }

    // Generate a secure token for the verification link
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_EXPIRY_MINUTES * 60 * 1000);

    await db
      .update(users)
      .set({
        pendingEmail: normalizedEmail,
        verificationCode: tokenHash,
        verificationCodeExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    await sendEmailChangeVerification(normalizedEmail, token);

    res.json({ success: true });
  } catch (error) {
    console.error("Change email error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Verify email change (public - token from email link proves identity)
router.post("/verify-email-change", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, error: "Token is required" });
    }

    const tokenHash = hashToken(token);

    // Find user by verification token hash with a pending email
    const user = await db.query.users.findFirst({
      where: eq(users.verificationCode, tokenHash),
    });

    if (!user || !user.pendingEmail) {
      return res.status(400).json({ success: false, error: "Invalid or expired link" });
    }

    if (!user.verificationCodeExpiresAt || user.verificationCodeExpiresAt < new Date()) {
      return res.status(400).json({ success: false, error: "This link has expired. Please request a new email change." });
    }

    // Update email and clear pending state
    await db
      .update(users)
      .set({
        email: user.pendingEmail,
        pendingEmail: null,
        verificationCode: null,
        verificationCodeExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.pendingEmail, name: user.name, avatar: user.avatar },
      },
    });
  } catch (error) {
    console.error("Verify email change error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Change password
router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: "Current password and new password are required" });
    }

    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({ success: false, error: "New password must be at least 6 characters" });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, req.user!.id),
    });

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ success: false, error: "Current password is incorrect" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    res.json({ success: true });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
