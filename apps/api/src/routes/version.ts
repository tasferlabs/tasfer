import { Router } from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const router = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const versionConfigPath =
  process.env.NODE_ENV === "production"
    ? "/app/version.json"
    : join(__dirname, "../../../../version.json");

interface VersionConfig {
  version: number;
  minVersion: number;
  updateUrls: {
    ios: string | null;
    android: string | null;
    web: string | null;
  };
}

function getVersionConfig(): VersionConfig {
  const content = readFileSync(versionConfigPath, "utf-8");
  return JSON.parse(content);
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
      minVersion: config.minVersion,
      latestVersion: config.version,
      updateUrls: config.updateUrls,
      // Include client info in response for debugging
      clientVersion: clientVersion ? parseInt(clientVersion, 10) : null,
      clientPlatform: clientPlatform || null,
    },
  });
});

export default router;
