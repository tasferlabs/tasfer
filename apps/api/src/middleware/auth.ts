import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import db from "../db/index.js";
import { sessions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { Errors } from "@shared/errors.js";

const SESSION_EXPIRY_DAYS = 90;
const SESSION_COOKIE = "session";

export interface AuthUser {
  id: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.[SESSION_COOKIE] || (req.headers["x-session-id"] as string);
  if (!sessionId) {
    res.status(401).json({ success: false, error: Errors.AUTH_REQUIRED });
    return;
  }

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
  });

  if (!session || session.expiresAt < new Date()) {
    res.status(401).json({ success: false, error: Errors.SESSION_EXPIRED });
    return;
  }

  // Lazy lookup user info from the session
  const { users } = await import("../db/schema.js");
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.userId),
    columns: { id: true, email: true },
  });

  if (!user) {
    res.status(401).json({ success: false, error: Errors.USER_NOT_FOUND });
    return;
  }

  req.user = { id: user.id, email: user.email };
  req.sessionId = sessionId;
  next();
}

/** Check if request originates from a native app (capacitor:// or custom scheme) */
function isNativeOrigin(req: Request): boolean {
  const origin = req.headers.origin || "";
  return origin.startsWith("capacitor://") || origin.startsWith("ionic://");
}

export async function createSession(userId: string, req: Request, res: Response): Promise<string> {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;

  await db.insert(sessions).values({
    id: sessionId,
    userId,
    ipAddress,
    userAgent,
    expiresAt,
  });

  const native = isNativeOrigin(req);

  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: native ? "none" : "lax",
    maxAge: SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });

  return sessionId;
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const sessionId = req.cookies?.[SESSION_COOKIE];
  if (sessionId) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  const native = isNativeOrigin(req);
  res.clearCookie(SESSION_COOKIE, {
    path: "/",
    sameSite: native ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

/** Validate a session ID and return the userId, or null if invalid */
export async function validateSession(sessionId: string): Promise<string | null> {
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
  });
  if (!session || session.expiresAt < new Date()) return null;
  return session.userId;
}

export { SESSION_COOKIE };
