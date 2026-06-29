/**
 * Cypher device-node SharedWorker (Phase 2 of the multi-tab rewrite).
 *
 * Promotes the worker from a bare SQLite proxy to the whole backend: one
 * `Engine` + one `Replicator` run here, shared by every tab on the origin. Each
 * connecting tab gets a {@link servePlatform} server over its port and is a thin
 * RPC client (`createPlatformClient`). Because there is exactly one Engine:
 *
 *   - the page/space listener sets are shared, so page-list changes in any tab
 *     update every tab's sidebar live (problem #1); and
 *   - the {@link RoomHub} fans operations/awareness across sibling tabs, so open
 *     editors converge live (problem #2).
 *
 * WebRTC can't run in a SharedWorker, so the network is an offline stub here;
 * Phase 3 swaps it for a proxy to an elected transport-host tab. Browsers
 * without SharedWorker fall back to the in-tab engine (see `index.ts`).
 */

import { Engine } from "../engine";
import { Replicator } from "../sync";
import { RoomHub } from "../rpc/room-hub";
import { servePlatform } from "../rpc/server";
import type { Driver } from "../driver";
import type { Platform } from "../types";
import { WaSqliteDb } from "./wa-sqlite-db";
import { OpfsFsDriver } from "./opfs-fs";
import { WebCryptoDriver } from "./web-crypto";
import { NetworkProxy } from "../rpc/net-proxy";

// A SharedWorker can't open OPFS sync access handles (`createSyncAccessHandle`
// is dedicated-worker-only) and can't spawn a nested dedicated `Worker` to do so
// (Chromium doesn't expose `Worker` in SharedWorkerGlobalScope), so SQLite runs
// here directly on an IndexedDB-backed VFS, which every worker context can reach.
const db = new WaSqliteDb({ acquireLock: true });
// WebRTC can't run here; the proxy forwards to whichever tab holds the
// `cypher-net` lock (registered via the `netHost` message below).
const netProxy = new NetworkProxy();
const driver: Driver = {
  db,
  fs: new OpfsFsDriver(),
  crypto: new WebCryptoDriver(),
  network: netProxy,
  basePath: "cypher",
};

const engine = new Engine(driver);
const replicator = new Replicator(driver.network, engine.asReplicatorHost());
engine.setReplicator(replicator);
engine.setSync(replicator);
const hub = new RoomHub(replicator);

console.log("[node] worker module evaluated");
(self as any).onerror = (e: unknown) =>
  console.error("[node] uncaught worker error:", e);

const ready: Promise<void> = (async () => {
  console.log("[node] init: waiting for db…");
  await db.whenReady();
  console.log("[node] init: db ready, running engine.init()…");
  await engine.init();
  console.log("[node] init: engine ready");
  replicator
    .start()
    .catch((e) => console.error("[node] replicator start failed:", e));
})();

let initError: Error | null = null;
ready.catch((e) => {
  initError = e instanceof Error ? e : new Error(String(e));
  console.error("[node] INIT FAILED:", initError);
});

let nextConnId = 1;

function serve(port: MessagePort): void {
  const connId = nextConnId++;
  console.log(`[node] serving connection #${connId}`);
  // Per-connection Platform: everything is the shared Engine except `sync`,
  // which is this tab's RoomHub facade so the hub knows who is calling.
  const perConn: Platform = {
    identity: engine.identity,
    peers: engine.peers,
    spaces: engine.spaces,
    pairing: engine.pairing,
    pages: engine.pages,
    assets: engine.assets,
    ops: engine.ops,
    snapshots: engine.snapshots,
    db: engine.db,
    sync: hub.connection(connId),
  };
  servePlatform(perConn, port, {
    onClose: () => hub.dropConnection(connId),
    onNetHost: (netPort) => netProxy.setHost(netPort),
  });
}

/**
 * Init failed (e.g. the database is locked by another connection, or the
 * IndexedDB VFS can't do I/O). Reply to every call with the error so the tab
 * surfaces it instead of spinning forever.
 *
 * We don't just forward `err.message` ("disk I/O error" is SQLite's generic
 * SQLITE_IOERR text): the error name and numeric `code` (incl. the extended
 * IOERR subcode) and stack are what actually pin down the fault, and the worker
 * console where they're logged isn't the page console, so callers never see
 * them. Pack them into the forwarded message instead.
 */
function describeInitError(err: Error): string {
  const code = (err as { code?: unknown }).code;
  const parts = [err.message];
  if (err.name && err.name !== "Error") parts.unshift(err.name);
  if (code != null) parts.push(`code=${String(code)}`);
  let msg = `device-node init failed: ${parts.join(" ")}`;
  if (err.stack) msg += `\n${err.stack}`;
  return msg;
}

function serveError(port: MessagePort, err: Error): void {
  const error = describeInitError(err);
  port.onmessage = (e: MessageEvent) => {
    const msg = e.data as { t?: string; id?: number };
    if (msg?.t === "call" && typeof msg.id === "number") {
      port.postMessage({ t: "return", id: msg.id, ok: false, error });
    }
  };
  port.start();
}

// tsconfig uses the DOM lib (not WebWorker), so SharedWorkerGlobalScope isn't
// typed — reach onconnect via `self as any`.
(self as any).onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  console.log("[node] onconnect");
  // Don't start the port here — servePlatform starts it once the handler is
  // attached, so messages the client queued before we're ready aren't dropped.
  ready.then(
    () => serve(port),
    () => serveError(port, initError ?? new Error("unknown init failure")),
  );
};
