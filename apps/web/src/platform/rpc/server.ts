/**
 * Platform RPC server — exposes a real `Platform` (the `Engine`) to a
 * {@link createPlatformClient} over an {@link RpcPort}.
 *
 * Generic over {@link PLATFORM_SCHEMA}: it dispatches calls/fires/subs by their
 * {@link MethodKind}, rebuilds proxied callback objects on this side, and
 * forwards subscription/callback fires back to the client. Reconstructed
 * callback objects contain *exactly* the keys the caller provided (sent as
 * `cbKeys`), so the engine can still introspect which callbacks exist.
 */

import type { Platform } from "../types";
import {
  PLATFORM_SCHEMA,
  RPC_INITIAL_STATE,
  type CallMsg,
  type ClientToServer,
  type FireMsg,
  type InitialState,
  type RpcPort,
  type SubscribeMsg,
} from "./protocol";

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Optional host hooks for a served connection.
 */
export interface ServeHooks {
  /** Runs after teardown when the client posts `close` (tab closing). */
  onClose?: () => void;
  /** Runs when the client posts `netHost` (it won the transport-host lock). */
  onNetHost?: (port: MessagePort) => void;
}

/**
 * Wire `platform` to `port`. Returns a teardown that drops all subscriptions
 * and callback handles created on this connection.
 */
export function servePlatform(
  platform: Platform,
  port: RpcPort,
  hooks?: ServeHooks,
): () => void {
  const ns = platform as unknown as Record<string, Record<string, AnyFn>>;
  /** subId → engine-side unsubscribe. */
  const subUnsubs = new Map<number, () => void>();
  /** Live callbackMethod handles; bounds proxied-callback fires. */
  const cbHandles = new Set<number>();

  port.onmessage = (e: MessageEvent) => {
    const msg = e.data as ClientToServer;
    switch (msg.t) {
      case "call":
        void handleCall(msg);
        break;
      case "fire":
        handleFire(msg);
        break;
      case "sub":
        handleSub(msg);
        break;
      case "unsub":
        subUnsubs.get(msg.subId)?.();
        subUnsubs.delete(msg.subId);
        break;
      case "releaseCb":
        cbHandles.delete(msg.handle);
        break;
      case "close":
        teardown();
        hooks?.onClose?.();
        break;
      case "netHost": {
        const netPort = e.ports?.[0];
        if (netPort) hooks?.onNetHost?.(netPort);
        break;
      }
    }
  };
  port.start?.();

  async function handleCall(msg: CallMsg): Promise<void> {
    try {
      // Built-in: seed the client's synchronous-getter mirrors.
      if (msg.ns === RPC_INITIAL_STATE.ns && msg.method === RPC_INITIAL_STATE.method) {
        const result: InitialState = {
          connectionState: platform.sync.getConnectionState(),
          connectedPeers: platform.sync.getConnectedPeers(),
        };
        port.postMessage({ t: "return", id: msg.id, ok: true, result });
        return;
      }

      const desc = PLATFORM_SCHEMA[msg.ns]?.[msg.method];
      const target = ns[msg.ns][msg.method];
      let args = msg.args;

      if (desc?.kind === "callbackMethod" && msg.cbHandle != null) {
        cbHandles.add(msg.cbHandle);
        args = msg.args.slice();
        args[desc.cbArg!] = buildCallbackObject(msg.cbHandle, msg.cbKeys ?? []);
      }

      const result = await target.apply(ns[msg.ns], args);
      port.postMessage({ t: "return", id: msg.id, ok: true, result });
    } catch (err) {
      port.postMessage({
        t: "return",
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handleFire(msg: FireMsg): void {
    try {
      ns[msg.ns][msg.method](...msg.args);
    } catch (err) {
      console.error(`[rpc] fire ${msg.ns}.${msg.method} failed:`, err);
    }
  }

  function handleSub(msg: SubscribeMsg): void {
    const desc = PLATFORM_SCHEMA[msg.ns]?.[msg.method];
    const target = ns[msg.ns][msg.method];
    let unsub: () => void;

    if (desc?.kind === "subscribeObject") {
      const cbObj: Record<string, AnyFn> = {};
      for (const key of msg.cbKeys ?? []) {
        cbObj[key] = (...args: unknown[]) =>
          port.postMessage({ t: "event", subId: msg.subId, key, args });
      }
      unsub = target.call(ns[msg.ns], cbObj) as () => void;
    } else {
      unsub = target.call(ns[msg.ns], (...args: unknown[]) =>
        port.postMessage({ t: "event", subId: msg.subId, args }),
      ) as () => void;
    }

    subUnsubs.set(msg.subId, unsub);
  }

  /** Build a callbacks object whose provided keys post `cb` messages back. */
  function buildCallbackObject(
    handle: number,
    keys: string[],
  ): Record<string, AnyFn> {
    const obj: Record<string, AnyFn> = {};
    for (const key of keys) {
      obj[key] = (...args: unknown[]) => {
        if (cbHandles.has(handle)) {
          port.postMessage({ t: "cb", handle, key, args });
        }
      };
    }
    return obj;
  }

  function teardown(): void {
    for (const unsub of subUnsubs.values()) {
      try {
        unsub();
      } catch {
        /* best-effort teardown */
      }
    }
    subUnsubs.clear();
    cbHandles.clear();
  }

  return teardown;
}
