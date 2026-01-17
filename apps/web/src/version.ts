/**
 * Version Configuration
 *
 * Values are injected at build time from /version.json at the monorepo root.
 * This is checked against the API's minimum required version.
 */

declare const __CLIENT_VERSION__: string;
declare const __BUILD_TIMESTAMP__: string;

/** Current client version (semantic versioning) - from version.json */
export const CLIENT_VERSION: string =
  typeof __CLIENT_VERSION__ !== "undefined" ? __CLIENT_VERSION__ : "1.0.0";

/** Build timestamp injected by Vite at build time */
export const BUILD_TIMESTAMP: string =
  typeof __BUILD_TIMESTAMP__ !== "undefined" ? __BUILD_TIMESTAMP__ : "dev";

/**
 * Parse semantic version string into comparable numbers
 */
export function parseVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
} {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return { major, minor, patch };
}

/**
 * Compare two semantic versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const vA = parseVersion(a);
  const vB = parseVersion(b);

  if (vA.major !== vB.major) return vA.major < vB.major ? -1 : 1;
  if (vA.minor !== vB.minor) return vA.minor < vB.minor ? -1 : 1;
  if (vA.patch !== vB.patch) return vA.patch < vB.patch ? -1 : 1;
  return 0;
}

/**
 * Check if current version meets the minimum required version
 */
export function meetsMinimumVersion(current: string, minimum: string): boolean {
  return compareVersions(current, minimum) >= 0;
}
