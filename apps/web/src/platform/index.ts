/**
 * Platform detection and singleton export.
 *
 * Detects the runtime environment and returns the correct Platform implementation.
 * All app code imports `platform` from here — never from a specific adapter.
 */

import type { Platform } from "./types";

// Re-export all types for convenience
export type * from "./types";

// =============================================================================
// Client platform detection (ios / android / web)
// =============================================================================

export type ClientPlatform = "ios" | "android" | "web";

function detectClientPlatform(): ClientPlatform {
  if (typeof window !== "undefined") {
    if (
      (window as any).webkit?.messageHandlers?.nativeApp ||
      (window as any).__CYPHER_IOS__
    ) {
      return "ios";
    }
    if ((window as any).AndroidBridge || (window as any).__CYPHER_ANDROID__) {
      return "android";
    }
    const ua = navigator.userAgent.toLowerCase();
    if (/iphone|ipad|ipod/.test(ua) && !/safari/.test(ua)) return "ios";
    if (/android/.test(ua) && /wv/.test(ua)) return "android";
  }
  return "web";
}

let _clientPlatform: ClientPlatform | null = null;

/** Get the client platform string ("ios" | "android" | "web"). */
export function getClientPlatform(): ClientPlatform {
  if (_clientPlatform === null) {
    _clientPlatform = detectClientPlatform();
  }
  return _clientPlatform;
}

// =============================================================================
// Platform adapter (full interface)
// =============================================================================

function detectAdapter(): "electron" | "capacitor" | "web" {
  if (typeof window === "undefined") return "web";
  if ((window as any).cypher) return "electron";
  if ((window as any).Capacitor?.isNativePlatform?.()) return "capacitor";
  return "web";
}

let _platform: Platform | null = null;

export async function initPlatform(): Promise<Platform> {
  if (_platform) return _platform;

  const env = detectAdapter();

  switch (env) {
    case "electron": {
      const { ElectronPlatform } = await import("./adapters/electron");
      _platform = new ElectronPlatform();
      break;
    }
    case "capacitor": {
      const { CapacitorPlatform } = await import("./adapters/capacitor");
      _platform = new CapacitorPlatform();
      break;
    }
    default: {
      const { WebPlatform } = await import("./adapters/web");
      _platform = new WebPlatform();
      break;
    }
  }

  return _platform;
}

/**
 * Get the platform instance. Must call initPlatform() first.
 * Throws if not initialized.
 */
export function getPlatform(): Platform {
  if (!_platform) {
    throw new Error("Platform not initialized. Call initPlatform() first.");
  }
  return _platform;
}
