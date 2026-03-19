/**
 * Legacy client utilities.
 *
 * Most API calls now go through the platform interface (`@/platform`).
 * This file keeps only the helpers that consumers still import directly.
 */

import { getPlatform } from "@/platform";

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

export const isNative =
  typeof window !== "undefined" &&
  !!(window as any).Capacitor?.isNativePlatform?.();

// ---------------------------------------------------------------------------
// Image URL helper (delegates to platform)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `getPlatform().assets.getUrl(hash)` directly.
 */
export function getAuthenticatedImageUrl(input: string): string {
  // If it's already a blob/data URL, pass through
  if (input.startsWith("blob:") || input.startsWith("data:")) {
    return input;
  }

  // Try to extract an asset hash from the URL path and delegate to platform
  try {
    const platform = getPlatform();
    // If it looks like an asset hash or ID, use platform
    // Otherwise pass through as-is (external URLs, etc.)
    return platform.assets.getUrl(input);
  } catch {
    // Platform not initialized yet — return as-is
    return input;
  }
}
