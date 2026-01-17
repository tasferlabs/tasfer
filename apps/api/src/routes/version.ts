import { Router } from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const router = Router();

// Read version config from monorepo root
const __dirname = dirname(fileURLToPath(import.meta.url));
const versionConfigPath = join(__dirname, "../../../../version.json");

interface VersionConfig {
  clientVersion: string;
  minClientVersion: string;
  recommendedClientVersion: string;
  apiVersion: string;
  updateMessage: string | null;
  updateUrls: {
    ios: string | null;
    android: string | null;
    web: string | null;
  };
}

function getVersionConfig(): VersionConfig {
  try {
    const content = readFileSync(versionConfigPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error("[Version] Failed to read version.json:", error);
    // Fallback defaults
    return {
      clientVersion: "1.0.0",
      minClientVersion: "1.0.0",
      recommendedClientVersion: "1.0.0",
      apiVersion: "1.0.0",
      updateMessage: null,
      updateUrls: {
        ios: null,
        android: null,
        web: null,
      },
    };
  }
}

/**
 * GET /api/version
 *
 * Returns version requirements for clients to check compatibility.
 * Clients should call this on startup to verify they meet minimum requirements.
 *
 * Optional headers:
 * - X-Client-Version: Current client version
 * - X-Client-Platform: Platform identifier (ios, android, web)
 */
router.get("/", (req, res) => {
  const config = getVersionConfig();
  const clientVersion = req.headers["x-client-version"] as string | undefined;
  const clientPlatform = req.headers["x-client-platform"] as string | undefined;

  res.json({
    success: true,
    data: {
      apiVersion: config.apiVersion,
      minClientVersion: config.minClientVersion,
      recommendedClientVersion: config.recommendedClientVersion,
      updateMessage: config.updateMessage,
      updateUrls: config.updateUrls,
      // Include client info in response for debugging
      clientVersion: clientVersion || null,
      clientPlatform: clientPlatform || null,
    },
  });
});

export default router;
