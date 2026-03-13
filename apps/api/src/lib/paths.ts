import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Returns the code root directory where source code lives.
 * - Production (Docker): /app/apps/api
 * - Development: apps/api/
 */
export function getRootDir(): string {
  // src/lib/ -> apps/api/
  return path.join(__dirname, "..", "..");
}

/**
 * Returns the application root directory (where version.json lives).
 * - Production (Docker): /app
 * - Development: monorepo root (cypher/)
 */
export function getAppDir(): string {
  if (process.env.NODE_ENV === "production") {
    return "/app";
  }
  // src/lib/ -> apps/api/ -> apps/ -> monorepo root
  return path.join(__dirname, "..", "..", "..", "..");
}
