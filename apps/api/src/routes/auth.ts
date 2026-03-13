import { Router } from "express";
import { createId } from "@paralleldrive/cuid2";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import db from "../db/index.js";
import { users, spaces } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requireAuth, createSession, destroySession } from "../middleware/auth.js";
import { sendVerificationEmail, sendPasswordResetEmail, sendEmailChangeVerification } from "../services/email.js";
import { Errors } from "@shared/errors.js";

const VERIFICATION_CODE_EXPIRY_MINUTES = 10;

const router = Router();

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateVerificationCode(): string {
  return crypto.randomInt(100000, 999999).toString();
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

function userResponse(user: { id: string; email: string; name: string; avatar: string | null }) {
  return { id: user.id, email: user.email, name: user.name, avatar: user.avatar };
}

// Register
router.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: Errors.EMAIL_PASSWORD_REQUIRED });
    }

    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ success: false, error: Errors.PASSWORD_MIN_LENGTH });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existing = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });

    if (existing) {
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
      return res.status(409).json({ success: false, error: Errors.EMAIL_ALREADY_IN_USE });
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

    const code = await setVerificationCode(userId);
    await sendVerificationEmail(normalizedEmail, code);

    res.json({
      success: true,
      data: { needsVerification: true, email: normalizedEmail },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ success: false, error: Errors.INTERNAL_ERROR });
  }
});

// Verify email
router.post("/verify-email", async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ success: false, error: Errors.EMAIL_CODE_REQUIRED });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

    if (!user) {
      return res.status(400).json({ success: false, error: Errors.INVALID_VERIFICATION_CODE });
    }

    if (user.emailVerified) {
      return res.status(400).json({ success: false, error: Errors.EMAIL_ALREADY_VERIFIED });
    }

    if (!user.verificationCode || !user.verificationCodeExpiresAt) {
      return res.status(400).json({ success: false, error: Errors.NO_VERIFICATION_PENDING });
    }

    if (user.verificationCodeExpiresAt < new Date()) {
      return res.status(400).json({ success: false, error: Errors.VERIFICATION_CODE_EXPIRED });
    }

    const codeHash = hashToken(code);
    if (codeHash !== user.verificationCode) {
      return res.status(400).json({ success: false, error: Errors.INVALID_VERIFICATION_CODE });
    }

    await db
      .update(users)
      .set({
        emailVerified: true,
        verificationCode: null,
        verificationCodeExpiresAt: null,
      })
      .where(eq(users.id, user.id));

    const sessionId = await createSession(user.id, req, res);

    res.json({
      success: true,
      data: { user: userResponse(user), sessionId },
    });
  } catch (error) {
    console.error("Verify email error:", error);
    res.status(500).json({ success: false, error: Errors.INTERNAL_ERROR });
  }
});

// Resend verification code
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: Errors.EMAIL_REQUIRED });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

    if (!user || user.emailVerified) {
      return res.json({ success: true });
    }

    const code = await setVerificationCode(user.id);
    await sendVerificationEmail(user.email, code);

    res.json({ success: true });
  } catch (error) {
    console.error("Resend verification error:", error);
    res.status(500).json({ success: false, error: Errors.INTERNAL_ERROR });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: Errors.EMAIL_PASSWORD_REQUIRED });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

    if (!user) {
      return res.status(401).json({ success: false, error: Errors.INVALID_CREDENTIALS });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ success: false, error: Errors.INVALID_CREDENTIALS });
    }

    if (!user.emailVerified) {
      const code = await setVerificationCode(user.id);
      await sendVerificationEmail(user.email, code);

      return res.json({
        success: true,
        data: { needsVerification: true, email: user.email },
      });
    }

    const sessionId = await createSession(user.id, req, res);

    res.json({
      success: true,
      data: { user: userResponse(user), sessionId },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, error: Errors.INTERNAL_ERROR });
  }
});

// Get current user (also serves as session check)
router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, req.user!.id),
    });

    if (!user) {
      return res.status(404).json({ success: false, error: Errors.USER_NOT_FOUND });
    }

    res.json({
      success: true,
      data: { user: userResponse(user) },
    });
  } catch (error) {
    console.error("Get me error:", error);
    res.status(500).json({ success: false, error: Errors.INTERNAL_ERROR });
  }
});

// Logout
router.post("/logout", async (req, res) => {
  try {
    await destroySession(req, res);
    res.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ success: false, error: Errors.INTERNAL_ERROR });
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
        return res.status(400).json({ success: false, error: Errors.NAME_INVALID_LENGTH });
      }
      updates.name = trimmed;
    }

    if (avatar !== undefined) {
      updates.avatar = avatar;
    }

    await db.update(users).set(updates).where(eq(users.id, req.user!.id));

    const user = await db.query.users.findFirst({
      where: eq(users.id, req.user!.id),
    });

    res.json({
      success: true,
      data: { user: userResponse(user!) },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ success: false, error: Errors.PROFILE_UPDATE_FAILED });
  }
});

// Forgot password
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: Errors.EMAIL_REQUIRED });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

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
    res.status(500).json({ success: false, error: Errors.INTERNAL_ERROR });
  }
});

// Reset password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ success: false, error: Errors.TOKEN_PASSWORD_REQUIRED });
    }

    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).json({ success: false, error: Errors.PASSWORD_MIN_LENGTH });
    }

    const tokenHash = hashToken(token);

    const user = await db.query.users.findFirst({
      where: eq(users.verificationCode, tokenHash),
    });

    if (!user) {
      return res.status(400).json({ success: false, error: Errors.INVALID_OR_EXPIRED_LINK });
    }

    if (!user.verificationCodeExpiresAt || user.verificationCodeExpiresAt < new Date()) {
      return res.status(400).json({ success: false, error: Errors.LINK_EXPIRED });
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
    res.status(500).json({ success: false, error: Errors.INTERNAL_ERROR });
  }
});

// Change email (request)
router.post("/change-email", requireAuth, async (req, res) => {
  try {
    const { newEmail } = req.body;

    if (!newEmail || typeof newEmail !== "string") {
      return res.status(400).json({ success: false, error: Errors.NEW_EMAIL_REQUIRED });
    }

    const normalizedEmail = newEmail.toLowerCase().trim();

    const user = await db.query.users.findFirst({
      where: eq(users.id, req.user!.id),
    });

    if (!user) {
      return res.status(404).json({ success: false, error: Errors.USER_NOT_FOUND });
    }

    if (normalizedEmail === user.email) {
      return res.status(400).json({ success: false, error: Errors.EMAIL_SAME_AS_CURRENT });
    }

    const existing = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });

    if (existing) {
      return res.status(409).json({ success: false, error: Errors.EMAIL_ALREADY_IN_USE });
    }

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
    res.status(500).json({ success: false, error: Errors.INTERNAL_ERROR });
  }
});

// Verify email change
router.post("/verify-email-change", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, error: Errors.TOKEN_REQUIRED });
    }

    const tokenHash = hashToken(token);

    const user = await db.query.users.findFirst({
      where: eq(users.verificationCode, tokenHash),
    });

    if (!user || !user.pendingEmail) {
      return res.status(400).json({ success: false, error: Errors.INVALID_OR_EXPIRED_LINK });
    }

    if (!user.verificationCodeExpiresAt || user.verificationCodeExpiresAt < new Date()) {
      return res.status(400).json({ success: false, error: Errors.EMAIL_CHANGE_LINK_EXPIRED });
    }

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
      data: { user: userResponse({ ...user, email: user.pendingEmail }) },
    });
  } catch (error) {
    console.error("Verify email change error:", error);
    res.status(500).json({ success: false, error: Errors.INTERNAL_ERROR });
  }
});

// Change password
router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: Errors.PASSWORDS_REQUIRED });
    }

    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({ success: false, error: Errors.NEW_PASSWORD_MIN_LENGTH });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, req.user!.id),
    });

    if (!user) {
      return res.status(404).json({ success: false, error: Errors.USER_NOT_FOUND });
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ success: false, error: Errors.CURRENT_PASSWORD_INCORRECT });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    res.json({ success: true });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ success: false, error: Errors.INTERNAL_ERROR });
  }
});

// Validate session (internal, used by live server)
router.get("/validate-session", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    return res.status(400).json({ success: false, error: Errors.SESSION_ID_REQUIRED });
  }

  const { validateSession } = await import("../middleware/auth.js");
  const userId = await validateSession(sessionId);

  if (!userId) {
    return res.status(401).json({ success: false });
  }

  res.json({ success: true, data: { userId } });
});

export default router;
