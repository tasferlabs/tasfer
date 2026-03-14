import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth.js";
import pagesRouter from "./routes/pages.js";
import imagesRouter from "./routes/images.js";
import spacesRouter from "./routes/spaces.js";
// import sharesRouter from "./routes/shares.js";
import versionRouter from "./routes/version.js";
import { requireAuth } from "./middleware/auth.js";
import { timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import { canAccessPage } from "./lib/permissions.js";

const app = express();
const PORT = process.env.PORT || 3000;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "ucW-2xcolFODh-pch4MCGILJPQ6mHZVhzIgPy2W93ftNQPBtTBstdUJNFLW5ixVj";

// TRAEFIK_AUTH format: "user:$2y$..." (htpasswd / bcrypt hash)
const TRAEFIK_AUTH = process.env.TRAEFIK_AUTH;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || true,
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// Basic auth gate — skip for routes that handle their own auth
if (TRAEFIK_AUTH) {
  const sep = TRAEFIK_AUTH.indexOf(":");
  const expectedUser = TRAEFIK_AUTH.slice(0, sep);
  const hashedPass = TRAEFIK_AUTH.slice(sep + 1);

  const SKIP_PATTERNS = [
    /^\/health$/,
    /^\/api\/auth(\/|$)/,
    /^\/api\/images\/[^/]+$/, // GET /api/images/:id
    /^\/api\/version(\/|$)/,
    /^\/api\/internal\//,
  ];

  app.use(async (req, res, next) => {
    if (SKIP_PATTERNS.some((p) => p.test(req.path))) return next();

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", "Basic realm=\"cypher\"");
      return res.status(401).send("Unauthorized");
    }

    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) {
      return res.status(401).send("Unauthorized");
    }

    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);

    if (user === expectedUser && await bcrypt.compare(pass, hashedPass)) {
      return next();
    }

    res.setHeader("WWW-Authenticate", "Basic realm=\"cypher\"");
    res.status(401).send("Unauthorized");
  });
}

// Routes
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Public auth routes
app.use("/api/auth", authRouter);

// Internal endpoint for live server to check page access (before requireAuth routes)
app.get("/api/internal/check-access", (req, res) => {
  const apiKey = req.headers["x-internal-key"];
  if (
    typeof apiKey !== "string" ||
    apiKey.length !== INTERNAL_API_KEY.length ||
    !timingSafeEqual(Buffer.from(apiKey), Buffer.from(INTERNAL_API_KEY))
  ) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const { userId, pageId } = req.query;
  if (!userId || !pageId) {
    res.status(400).json({ success: false, error: "userId and pageId are required" });
    return;
  }

  canAccessPage(userId as string, pageId as string, "view")
    .then((hasAccess) => {
      res.json({ success: true, data: { hasAccess } });
    })
    .catch((error) => {
      console.error("Check access error:", error);
      res.status(500).json({ success: false, error: "Internal server error" });
    });
});

// Protected routes
app.use("/api/pages", requireAuth, pagesRouter);
app.use("/api/images", imagesRouter); // Auth applied per-route inside router
app.use("/api/spaces", requireAuth, spacesRouter);
// app.use("/api", requireAuth, sharesRouter);
app.use("/api/version", versionRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
