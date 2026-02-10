import path from "path";

/**
 * Returns the code root directory where compiled/source code lives.
 * - Production (Docker): /app/dist
 * - Development: apps/live/
 */
export function getRootDir(): string {
  if (process.env.NODE_ENV === "production") {
    return "/app/dist";
  }
  // In dev: src/lib/ -> apps/live/
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
  // In dev: src/lib/ -> apps/live/ -> apps/ -> monorepo root
  return path.join(__dirname, "..", "..", "..", "..");
}
