/**
 * Network driver for the headless host.
 *
 * The transport itself is the app's — `createWebRtcNetworkDriver` is the same
 * code the browser, desktop and mobile clients run, so a headless host is an
 * ordinary peer on the wire. Node only has to supply what a browser provides
 * for free:
 *
 *   - `WebSocket`, for signaling. Global since Node 22.
 *   - `RTCPeerConnection` and friends, for direct DataChannels. Node has no
 *     WebRTC stack, so this comes from the optional `node-datachannel`
 *     dependency — a prebuilt native module that not every machine can install.
 *
 * Without that module the host still syncs: it takes the driver's relay path
 * from the first frame instead of after a failed ICE attempt — the `relayOnly`
 * option in `adapters/webrtc.ts`. That trades the relay's bandwidth for
 * working anywhere, which is the right default for a server nobody is watching
 * — the frames stay encrypted to the topic key either way.
 */

import type { NetworkDriver } from "@/platform/driver";
import { createWebRtcNetworkDriver } from "@/platform/adapters/webrtc";

/** How the host should reach its peers. */
export type Transport = "auto" | "direct" | "relay";

/** The WebRTC constructors `webrtc.ts` reaches for as globals. */
const WEBRTC_GLOBALS = [
  "RTCPeerConnection",
  "RTCSessionDescription",
  "RTCIceCandidate",
  "RTCDataChannel",
] as const;

export interface NetworkSetup {
  driver: NetworkDriver;
  /** True when direct DataChannels are available; false means relay-only. */
  direct: boolean;
  /** Relay-only because the operator asked for it, not because it had to be. */
  relayByChoice: boolean;
  /** Release the native WebRTC runtime, if one was loaded. */
  cleanup(): Promise<void>;
}

/**
 * Install `node-datachannel`'s WebRTC polyfill as globals. Returns false when
 * the module is not installed — the caller decides whether that is fatal.
 */
/**
 * libdatachannel runs its own thread pool, and it keeps the process alive
 * after every socket is closed. Shutdown has to release it explicitly.
 */
async function releaseWebRtc(): Promise<void> {
  try {
    const nodeDataChannel = (await import("node-datachannel")) as unknown as {
      cleanup?: () => void;
      default?: { cleanup?: () => void };
    };
    (nodeDataChannel.cleanup ?? nodeDataChannel.default?.cleanup)?.();
  } catch {
    /* never loaded, or already gone */
  }
}

async function installWebRtcGlobals(): Promise<boolean> {
  let polyfill: Record<string, unknown>;
  try {
    polyfill = (await import("node-datachannel/polyfill")) as unknown as Record<
      string,
      unknown
    >;
  } catch {
    return false;
  }

  for (const name of WEBRTC_GLOBALS) {
    const impl = polyfill[name];
    if (typeof impl !== "function") return false;
    // Never overwrite a runtime that already has WebRTC of its own.
    if (!(name in globalThis)) {
      (globalThis as Record<string, unknown>)[name] = impl;
    }
  }
  return true;
}

export async function createNetwork(
  signalUrl: string,
  transport: Transport,
): Promise<NetworkSetup> {
  if (typeof WebSocket === "undefined") {
    throw new Error(
      "This Node build has no global WebSocket. Tasfer's host needs Node 22 or newer.",
    );
  }

  const wantsDirect = transport !== "relay";
  const direct = wantsDirect ? await installWebRtcGlobals() : false;

  if (transport === "direct" && !direct) {
    throw new Error(
      "--transport direct needs the optional node-datachannel package: install it, or use --transport relay.",
    );
  }

  return {
    driver: createWebRtcNetworkDriver(signalUrl, { relayOnly: !direct }),
    direct,
    relayByChoice: transport === "relay",
    cleanup: direct ? releaseWebRtc : async () => {},
  };
}
