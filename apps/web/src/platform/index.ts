/**
 * Platform detection and singleton export.
 *
 * Detects the runtime environment, creates the appropriate Driver,
 * and wraps it in the shared Engine. All app code imports from here.
 */

import { invariant } from "@shared/invariant";
import type { DeviceType, Platform } from "./types";
import { Engine } from "./engine";
import { Replicator } from "./sync";
import { createPlatformClient } from "./rpc/client";
import { startNetworkHostElection } from "./rpc/net-host";
// Static `?sharedworker` import — the only form Vite reliably compiles to a
// SharedWorker. A dynamic `import("...?sharedworker")` runs the module on the
// main thread instead. The SharedWorker hosts the Engine and runs SQLite on an
// IndexedDB-backed VFS (OPFS sync access handles are dedicated-worker-only, and
// a SharedWorker can't spawn a worker to reach them). Importing the constructor
// does not start the worker; `new` does.
import CypherNodeWorker from "./adapters/node.sharedworker?sharedworker";

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

/**
 * Infer the device form factor from the user agent. Used purely for presence —
 * it lets a collaboration UI tell two people apart when they share a name. It is
 * derived on the fly (never stored or user-edited): the device a person is on is
 * a property of the running client, not of their identity.
 *
 * Desktop vs. laptop is indistinguishable from the user agent, so non-touch
 * machines collapse to "laptop".
 */
export function detectDeviceType(): DeviceType {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent;

  // Tablets first — they can otherwise look like a phone or a desktop. iPadOS
  // reports a "Macintosh" UA, so disambiguate it by the presence of touch.
  if (
    /iPad/i.test(ua) ||
    (/Macintosh/i.test(ua) &&
      typeof document !== "undefined" &&
      "ontouchend" in document)
  ) {
    return "tablet";
  }
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return "tablet";

  // Phones
  if (/iPhone|iPod/i.test(ua)) return "phone";
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return "phone";

  return "laptop";
}

// =============================================================================
// Platform adapter (full interface)
// =============================================================================

type AdapterType = "electron" | "capacitor" | "web";
type DetailedAdapterType =
  | "electron-macos"
  | "electron-windows"
  | "electron-linux"
  | "capacitor-native"
  | "capacitor-web"
  | "electron"
  | "capacitor"
  | "web";

export function detectAdapter(): AdapterType {
  if (typeof window === "undefined") return "web";
  if ((window as any).cypher) return "electron";
  if ((window as any).Capacitor?.isNativePlatform?.()) return "capacitor";
  return "web";
}

export function detectAdapterDetailed(): DetailedAdapterType {
  if (typeof window === "undefined") return "web";
  if ((window as any).cypher) {
    if ((window as any).cypher.platform === "darwin") {
      return "electron-macos";
    } else if ((window as any).cypher.platform === "win32") {
      return "electron-windows";
    } else if ((window as any).cypher.platform === "linux") {
      return "electron-linux";
    }
    return "electron";
  }
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

  const signalUrl =
    import.meta.env.VITE_SIGNAL_URL ?? "wss://signaling.cypher.md";

  // Web: the device-node SharedWorker is the one and only path. The Engine +
  // Replicator run in the worker, SQLite runs there on an IndexedDB-backed VFS,
  // and this tab is a thin RPC client — one source of truth, live cross-tab
  // convergence. One tab is elected (Web Locks) to host the single WebRTC
  // connection on the worker's behalf. SharedWorker is required; every current
  // browser (Chrome/Edge/Firefox; Safari 16.4+) ships it.
  if (env === "web") {
    if (typeof SharedWorker === "undefined") {
      throw new Error(
        "This browser does not support SharedWorker, which Cypher requires. " +
          "Please use a current version of Chrome, Edge, Firefox, or Safari 16.4+.",
      );
    }
    const worker = new CypherNodeWorker();
    const client = createPlatformClient(worker.port);
    startNetworkHostElection(worker.port, signalUrl);
    console.log("[platform] device-node SharedWorker active");
    _platform = client;
    _g.__cypher_platform = client;
    return client;
  }

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
      // env is "electron" | "capacitor" | "web"; web returned above.
      throw new Error(`Unknown platform adapter: ${env}`);
    }
  }

  // Start the replicator in the background — do not block app render on network I/O
  replicator.start().catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Sync] Replicator failed to start: ${msg}`);
  });

  // Make sync lifecycle-aware: pause/flush on app background, reconnect on
  // foreground. Native (iOS/Android) drives this via window.__cypherLifecycle;
  // the controller also self-wires a visibilitychange/pagehide fallback that is
  // harmless on electron. HMR-safe: dispose any prior instance before wiring.
  {
    const { SyncLifecycleController } = await import("./sync-lifecycle");
    _g.__cypher_syncLifecycle?.dispose?.();
    const dispose = new SyncLifecycleController(replicator).install();
    _g.__cypher_syncLifecycle = { dispose };
  }

  _platform = engine;
  _g.__cypher_platform = engine;
  return _platform;
}

/**
 * Get the platform instance. Must call initPlatform() first.
 * Throws if not initialized.
 */
export function getPlatform(): Platform {
  invariant(_platform, "Platform not initialized. Call initPlatform() first.");
  return _platform;
}
