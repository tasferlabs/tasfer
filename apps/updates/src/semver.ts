/**
 * Just enough semver to order `X.Y.Z` bundle versions.
 *
 * Deliberately strict: anything that is not three plain integers is rejected
 * rather than coerced. Bundle versions are minted by our own release pipeline,
 * so a value that does not parse means something upstream is wrong — and a
 * lenient parse here would silently mis-order an update, which is the one
 * failure this server must never produce.
 *
 * Devices can still report an unparseable `version_name`: the plugin falls
 * back to a placeholder when it has no bundle metadata. Callers handle that by
 * treating a null parse as "no usable baseline" (see check.ts), not by
 * guessing.
 */

const PLAIN_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export type SemVer = readonly [number, number, number];

export function parseVersion(value: string | undefined | null): SemVer | null {
  if (!value) return null;
  const m = PLAIN_SEMVER.exec(value.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative when `a < b`, zero when equal, positive when `a > b`. */
export function compareVersions(a: SemVer, b: SemVer): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
