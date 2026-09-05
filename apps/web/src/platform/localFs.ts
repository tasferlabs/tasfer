/**
 * A main-thread {@link FsDriver}, independent of the engine.
 *
 * On the web the engine lives in a SharedWorker and the tab only holds an RPC
 * client, so there is no `Driver` to borrow `fs` from; features that keep
 * device-local files of their own (imported spelling dictionaries) ask for one
 * here instead. Same origin, same OPFS root as the worker — the paths are what
 * keep them apart.
 */

import { detectAdapter } from ".";
import type { FsDriver } from "./driver";

let cached: Promise<FsDriver> | null = null;

/** The filesystem this device uses. Cached: repeat calls share one driver. */
export function localFs(): Promise<FsDriver> {
  if (!cached) {
    cached = create().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

async function create(): Promise<FsDriver> {
  switch (detectAdapter()) {
    case "electron": {
      const { createElectronFsDriver } = await import("./adapters/electron");
      return createElectronFsDriver();
    }
    case "capacitor": {
      const { createCapacitorFsDriver } = await import("./adapters/capacitor");
      return createCapacitorFsDriver();
    }
    default: {
      const { OpfsFsDriver } = await import("./adapters/opfs-fs");
      return new OpfsFsDriver();
    }
  }
}
