/**
 * Platform detection and singleton export.
 *
 * Detects the runtime environment, creates the appropriate Driver,
 * and wraps it in the shared Engine. All app code imports from here.
 */

import type { Platform } from "./types";
import { Engine } from "./engine";
import { Replicator } from "./sync";

// Re-export all types for convenience
export type * from "./types";
export type * from "./driver";

// =============================================================================
// Client platform detection (ios / android / web)
// =============================================================================

export type ClientPlatform = "ios" | "android" | "electron" | "web";

function detectClientPlatform(): ClientPlatform {
  if (typeof window !== "undefined") {
    if ((window as any).cypher) return "electron";
    // Check for unified CypherBridge first, then legacy markers
    if (
      (window as any).__CYPHER_IOS__ ||
      (window as any).webkit?.messageHandlers?.nativeApp
    ) {
      return "ios";
    }
    if ((window as any).__CYPHER_ANDROID__ || (window as any).__NativeBridge) {
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

type AdapterType = "electron" | "capacitor" | "web";

export function detectAdapter(): AdapterType {
  if (typeof window === "undefined") return "web";
  if ((window as any).cypher) return "electron";
  if ((window as any).Capacitor?.isNativePlatform?.()) return "capacitor";
  return "web";
}

// Store on globalThis so Vite HMR module re-evaluation doesn't lose the instance
const _g = globalThis as any;
let _platform: Platform | null = _g.__cypher_platform ?? null;
let _initPromise: Promise<Platform> | null = _g.__cypher_initPromise ?? null;

export async function initPlatform(): Promise<Platform> {
  if (_platform) return _platform;
  if (_initPromise) return _initPromise;

  _initPromise = _initPlatformInner().catch((e) => {
    _initPromise = null;
    _g.__cypher_initPromise = null;
    throw e;
  });
  _g.__cypher_initPromise = _initPromise;
  return _initPromise;
}

async function _initPlatformInner(): Promise<Platform> {
  const env = detectAdapter();
  const signalUrl = import.meta.env.VITE_SIGNAL_URL ?? "wss://signaling.cypher.md";
  let engine: Engine;
  let replicator: Replicator;

  switch (env) {
    case "electron": {
      const { createElectronDriver } = await import("./adapters/electron");
      const driver = createElectronDriver(signalUrl);
      engine = new Engine(driver);
      await engine.init();
      replicator = new Replicator(driver.network, engine.asReplicatorHost());
      engine.setReplicator(replicator);
      engine.setSync(replicator);
      break;
    }
    case "capacitor": {
      const { createCapacitorDriver } = await import("./adapters/capacitor");
      const driver = createCapacitorDriver(signalUrl);
      engine = new Engine(driver);
      await engine.init();
      replicator = new Replicator(driver.network, engine.asReplicatorHost());
      engine.setReplicator(replicator);
      engine.setSync(replicator);
      break;
    }
    default: {
      const { createWebDriver } = await import("./adapters/web");
      const driver = createWebDriver(signalUrl);
      engine = new Engine(driver);
      await engine.init();
      replicator = new Replicator(driver.network, engine.asReplicatorHost());
      engine.setReplicator(replicator);
      engine.setSync(replicator);
      break;
    }
  }

  // Start the replicator — connects to all trusted peers for background sync
  await replicator.start();

  _platform = engine;
  _g.__cypher_platform = engine;
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
