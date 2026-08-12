/**
 * Version Configuration
 *
 * Values are injected at build time from /version.json at the monorepo root.
 */

declare const __CLIENT_VERSION__: number;
declare const __APP_VERSION__: string;
declare const __BUILD_TIMESTAMP__: string;
declare const __BUILD_COMMIT__: string;

/** Current client version (integer) - from version.json */
export const CLIENT_VERSION: number =
  typeof __CLIENT_VERSION__ !== "undefined" ? __CLIENT_VERSION__ : 1;

/** Marketing version (semver) users see - from apps/web/package.json */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

/** Build instant as an ISO 8601 UTC string, injected by Vite at build time */
export const BUILD_TIMESTAMP: string =
  typeof __BUILD_TIMESTAMP__ !== "undefined" ? __BUILD_TIMESTAMP__ : "dev";

/** The build instant as a Date, or null when no build metadata was injected. */
export function getBuildDate(): Date | null {
  const parsed = new Date(BUILD_TIMESTAMP);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Short git commit of the build (with a `-dirty` suffix when uncommitted) */
export const BUILD_COMMIT: string =
  typeof __BUILD_COMMIT__ !== "undefined" ? __BUILD_COMMIT__ : "dev";
