/**
 * Version Configuration
 *
 * Values are injected at build time from /version.json at the monorepo root.
 * This is checked against the API's minimum required version.
 */

declare const __CLIENT_VERSION__: number;
declare const __BUILD_TIMESTAMP__: string;

/** Current client version (integer) - from version.json */
export const CLIENT_VERSION: number =
  typeof __CLIENT_VERSION__ !== "undefined" ? __CLIENT_VERSION__ : 1;

/** Build timestamp injected by Vite at build time */
export const BUILD_TIMESTAMP: string =
  typeof __BUILD_TIMESTAMP__ !== "undefined" ? __BUILD_TIMESTAMP__ : "dev";

/**
 * Check if current version meets the minimum required version
 */
export function meetsMinimumVersion(current: number, minimum: number): boolean {
  return current >= minimum;
}
