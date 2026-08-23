/**
 * Headless host runtime.
 *
 * A Tasfer host is an ordinary replica with no UI: the same Engine, the same
 * Replicator, the same CRDT and wire protocol the app runs, wired to Node's
 * SQLite, filesystem and sockets. It holds the person's spaces and stays
 * online, so their devices converge through it instead of having to be awake
 * at the same time.
 *
 * It is a *replica*, not a server: it stores the same encrypted-in-transit op
 * log every other device of theirs holds, and it earns that copy the same way
 * — by being linked as one of their devices.
 */

import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { Engine } from "@/platform/engine";
import { Replicator } from "@/platform/sync";
import type { Driver } from "@/platform/driver";
import { NodeCryptoDriver } from "./crypto";
import { NodeDbDriver } from "./db";
import { NodeFsDriver } from "./fs";
import { createNetwork, type Transport } from "./network";

/** Where the app's own relay lives, so the CLI needs no configuration to work. */
export const DEFAULT_SIGNAL_URL = "wss://signaling.tasfer.app";

const DB_FILE = "tasfer.db";

/** How long shutdown waits for queued sync frames to reach the wire. */
const FLUSH_TIMEOUT_MS = 2000;

/**
 * The data directory, in platform order of preference. Same shape as the
 * desktop app's `userData`, so an operator can find (and back up) one
 * directory holding the database and every asset blob.
 */
export function defaultDataDir(): string {
  const env = process.env.TASFER_DATA_DIR;
  if (env) return path.resolve(env);

  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "tasfer");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
      "tasfer",
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
    "tasfer",
  );
}

export interface HostOptions {
  dataDir: string;
  signalUrl: string;
  transport: Transport;
}

export interface Host {
  engine: Engine;
  replicator: Replicator;
  dataDir: string;
  /** False when the host has no WebRTC stack and syncs through the relay. */
  direct: boolean;
  /** Relay-only by request rather than for want of a WebRTC stack. */
  relayByChoice: boolean;
  /** Stop replicating and close the database. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Open the local replica: schema, identity, network. Does not start
 * replicating — commands that only read (`status`) skip that entirely, and the
 * pairing commands start it themselves once their session is attached.
 */
export async function openHost(options: HostOptions): Promise<Host> {
  const dataDir = path.resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true });

  const db = new NodeDbDriver(path.join(dataDir, DB_FILE));
  const {
    driver: network,
    direct,
    relayByChoice,
    cleanup: releaseNetwork,
  } = await createNetwork(options.signalUrl, options.transport);

  const driver: Driver = {
    db,
    fs: new NodeFsDriver(dataDir),
    crypto: new NodeCryptoDriver(),
    network,
    // Paths from the Engine are relative; the fs driver roots them in dataDir,
    // the same split the desktop app uses between renderer and main process.
    basePath: "",
  };

  const engine = new Engine(driver);
  await engine.init();

  const replicator = new Replicator(network, engine.asReplicatorHost());
  engine.setReplicator(replicator);
  engine.setSync(replicator);

  let closed = false;
  return {
    engine,
    replicator,
    dataDir,
    direct,
    relayByChoice,
    async close() {
      if (closed) return;
      closed = true;
      // Give whatever is mid-flight a moment to reach the wire before the
      // sockets go: an interrupted host should not lose the round it was in.
      try {
        await network.flush?.(FLUSH_TIMEOUT_MS);
        await replicator.destroy();
      } catch (e) {
        console.warn("[host] shutdown was not clean:", e);
      }
      // The Replicator drops its topics but not the driver underneath, and its
      // credential timer would keep the process alive.
      await network.destroy().catch(() => {});
      await releaseNetwork();
      // The database handle is deliberately left open. Engine work can still
      // be settling when the transport stops — trusting a peer it just paired
      // with, rebinding a certificate — and pulling the handle out from under
      // it turns a harmless late write into a crash. SQLite commits per
      // transaction, so a process that exits after this loses nothing.
    },
  };
}
