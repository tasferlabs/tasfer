/**
 * Platform RPC client — builds a `Platform` whose methods are serialized over
 * an {@link RpcPort} to a {@link servePlatform} server wrapping the real
 * `Engine`.
 *
 * Entirely generic: it iterates {@link PLATFORM_SCHEMA} and wires each method
 * by its {@link MethodKind}. The only hand-written bits are the two synchronous
 * getters (`sync.getConnectionState`, `sync.getConnectedPeers`), which are
 * served from tab-local mirrors seeded once on connect and kept fresh by
 * internal subscriptions.
 */

import type { Platform } from "../types";
import {
  PLATFORM_SCHEMA,
  RPC_INITIAL_STATE,
  type InitialState,
  type RpcPort,
  type ServerToClient,
} from "./protocol";

type AnyFn = (...args: unknown[]) => unknown;
type CbObject = Record<string, AnyFn | undefined>;

interface Subscription {
  /** Single-callback subscription. */
  single?: AnyFn;
  /** Object-of-callbacks subscription (dispatched by key). */
  obj?: CbObject;
}

export function createPlatformClient(port: RpcPort): Platform {
  let nextCallId = 1;
  let nextSubId = 1;
  let nextCbHandle = 1;

  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; label: string }
  >();
  const subs = new Map<number, Subscription>();
  const cbTables = new Map<number, CbObject>();

  // Mirrors backing the synchronous getters. Seeded by RPC_INITIAL_STATE and
  // kept current by the internal subscriptions opened at the bottom.
  const mirrors: { connectionState: unknown; connectedPeers: unknown } = {
    connectionState: "disconnected",
    connectedPeers: [],
  };

  port.onmessage = (e: MessageEvent) => {
    const msg = e.data as ServerToClient;
    switch (msg.t) {
      case "return": {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else {
          console.error(`[rpc] ${p.label} failed:`, msg.error);
          p.reject(new Error(msg.error ?? "RPC error"));
        }
        break;
      }
      case "event": {
        const sub = subs.get(msg.subId);
        if (!sub) return;
        if (msg.key != null) sub.obj?.[msg.key]?.(...msg.args);
        else sub.single?.(...msg.args);
        break;
      }
      case "cb": {
        cbTables.get(msg.handle)?.[msg.key]?.(...msg.args);
        break;
      }
    }
  };
  port.start?.();

  function call(
    ns: string,
    method: string,
    args: unknown[],
    extra?: { cbHandle?: number; cbKeys?: string[] },
  ): Promise<unknown> {
    const id = nextCallId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, label: `${ns}.${method}` });
      port.postMessage({
        t: "call",
        id,
        ns,
        method,
        args,
        cbHandle: extra?.cbHandle,
        cbKeys: extra?.cbKeys,
      });
    });
  }

  function fire(ns: string, method: string, args: unknown[]): void {
    port.postMessage({ t: "fire", ns, method, args });
  }

  function subscribe(
    ns: string,
    method: string,
    sub: Subscription,
    cbKeys?: string[],
  ): () => void {
    const subId = nextSubId++;
    subs.set(subId, sub);
    port.postMessage({ t: "sub", subId, ns, method, cbKeys });
    return () => {
      subs.delete(subId);
      port.postMessage({ t: "unsub", subId });
    };
  }

  function callbackMethod(
    ns: string,
    method: string,
    args: unknown[],
    cbArg: number,
  ): Promise<unknown> {
    const handle = nextCbHandle++;
    const cbObj = (args[cbArg] ?? {}) as CbObject;
    cbTables.set(handle, cbObj);
    const sendArgs = args.slice();
    sendArgs[cbArg] = undefined; // functions can't cross postMessage
    // NB (Phase 1): handles are not GC'd until the port closes. The worker
    // (Phase 2) ties handle lifetime to the port, so this is acceptable here.
    return call(ns, method, sendArgs, {
      cbHandle: handle,
      cbKeys: Object.keys(cbObj),
    });
  }

  const platform: Record<string, Record<string, AnyFn>> = {};

  for (const [ns, methods] of Object.entries(PLATFORM_SCHEMA)) {
    platform[ns] = {};
    for (const [method, desc] of Object.entries(methods)) {
      switch (desc.kind) {
        case "request":
          platform[ns][method] = (...args) => call(ns, method, args);
          break;
        case "fire":
          platform[ns][method] = (...args) => fire(ns, method, args);
          break;
        case "subscribe":
          platform[ns][method] = (cb) =>
            subscribe(ns, method, { single: cb as AnyFn });
          break;
        case "subscribeObject":
          platform[ns][method] = (cbObj) => {
            const obj = (cbObj ?? {}) as CbObject;
            return subscribe(ns, method, { obj }, Object.keys(obj));
          };
          break;
        case "callbackMethod":
          platform[ns][method] = (...args) =>
            callbackMethod(ns, method, args, desc.cbArg!);
          break;
        case "getter":
          // Wired explicitly below from mirrors.
          break;
      }
    }
  }

  // Synchronous getters, served from mirrors.
  platform.sync.getConnectionState = () => mirrors.connectionState;
  platform.sync.getConnectedPeers = () => mirrors.connectedPeers;

  // Assets: mint blob URLs tab-side from bytes fetched over RPC, so they're
  // valid in this document even when the engine lives in a worker.
  const blobUrlCache = new Map<string, string>();
  platform.assets.getUrl = (async (hash: string) => {
    const cached = blobUrlCache.get(hash);
    if (cached) return cached;
    const bytes = (await call("assets", "getBytes", [hash])) as {
      data: Uint8Array;
      mime: string;
    } | null;
    if (!bytes) throw new Error(`Asset not found: ${hash}`);
    const url = URL.createObjectURL(
      new Blob([bytes.data as BlobPart], { type: bytes.mime }),
    );
    blobUrlCache.set(hash, url);
    return url;
  }) as AnyFn;
  const serverDelete = platform.assets.delete;
  platform.assets.delete = (async (hash: string) => {
    const url = blobUrlCache.get(hash);
    if (url) {
      URL.revokeObjectURL(url);
      blobUrlCache.delete(hash);
    }
    return serverDelete(hash);
  }) as AnyFn;

  // Seed mirrors once, then track changes. Internal subscriptions are separate
  // from any the consumer opens, so user callbacks keep native semantics.
  void call(RPC_INITIAL_STATE.ns, RPC_INITIAL_STATE.method, []).then((s) => {
    const init = s as InitialState;
    mirrors.connectionState = init.connectionState;
    mirrors.connectedPeers = init.connectedPeers;
  });
  subscribe("sync", "onConnectionChange", {
    single: (state) => {
      mirrors.connectionState = state;
    },
  });
  subscribe("sync", "onConnectedPeersChange", {
    single: (peers) => {
      mirrors.connectedPeers = peers;
    },
  });

  // Tell the server promptly when this tab goes away — a SharedWorker port has
  // no reliable close event, so without this the hub keeps ghost members.
  if (typeof addEventListener === "function") {
    addEventListener("pagehide", () => port.postMessage({ t: "close" }));
  }

  return platform as unknown as Platform;
}
