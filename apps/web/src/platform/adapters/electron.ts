/**
 * Electron Driver
 *
 * Delegates database and filesystem operations to the Electron main process
 * via IPC. The main process uses better-sqlite3 and node:fs.
 *
 * This is just the thin driver — all business logic is in Engine.
 */

import type { Driver, DbDriver, DbRow, DbRunResult, FsDriver } from "../driver";
import type { Platform } from "../types";
import type { AwarenessState } from "@/editor/sync/awareness";

// =============================================================================
// Electron IPC Bridge
// =============================================================================

interface ElectronBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): () => void;
}

function getBridge(): ElectronBridge {
  const bridge = (window as any).cypher as ElectronBridge | undefined;
  if (!bridge) throw new Error("Electron bridge not available");
  return bridge;
}

// =============================================================================
// IPC Database Driver
// =============================================================================

class IpcDbDriver implements DbDriver {
  private bridge: ElectronBridge;
  constructor(bridge: ElectronBridge) {
    this.bridge = bridge;
  }

  async execute<T extends DbRow = DbRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    return (await this.bridge.invoke("db:execute", sql, params)) as T[];
  }

  async run(sql: string, params?: unknown[]): Promise<DbRunResult> {
    return (await this.bridge.invoke("db:run", sql, params)) as DbRunResult;
  }

  async exec(sql: string): Promise<void> {
    await this.bridge.invoke("db:exec", sql);
  }

  async transaction<T>(fn: (db: DbDriver) => Promise<T>): Promise<T> {
    // For Electron, we send BEGIN/COMMIT/ROLLBACK over IPC.
    // The main process holds the actual transaction.
    await this.exec("BEGIN");
    try {
      const result = await fn(this);
      await this.exec("COMMIT");
      return result;
    } catch (e) {
      await this.exec("ROLLBACK");
      throw e;
    }
  }
}

// =============================================================================
// IPC Filesystem Driver
// =============================================================================

class IpcFsDriver implements FsDriver {
  private bridge: ElectronBridge;
  constructor(bridge: ElectronBridge) {
    this.bridge = bridge;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const result = await this.bridge.invoke("fs:read", path);
    if (result === null) return null;
    // IPC transfers ArrayBuffer
    return new Uint8Array(result as ArrayBuffer);
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await this.bridge.invoke("fs:write", path, data.buffer);
  }

  async delete(path: string): Promise<void> {
    await this.bridge.invoke("fs:delete", path);
  }

  async list(dir: string): Promise<string[]> {
    return (await this.bridge.invoke("fs:list", dir)) as string[];
  }

  async exists(path: string): Promise<boolean> {
    return (await this.bridge.invoke("fs:exists", path)) as boolean;
  }
}

// =============================================================================
// Electron Sync (P2P via main process)
// =============================================================================

export function createElectronSync(bridge: ElectronBridge): Platform["sync"] {
  return {
    joinRoom: (roomId: string, peerId: string, user?: any, callbacks?: any) => {
      if (callbacks) {
        for (const [event, cb] of Object.entries(callbacks)) {
          if (cb) bridge.on(`sync:${roomId}:${event}`, cb as any);
        }
      }
      return bridge.invoke("sync:joinRoom", roomId, peerId, user) as Promise<void>;
    },
    leaveRoom: (roomId: string) =>
      bridge.invoke("sync:leaveRoom", roomId) as Promise<void>,
    sendOperations: (roomId: string, ops: any[]) => {
      bridge.invoke("sync:sendOperations", roomId, ops);
    },
    sendSyncRequest: (roomId: string, vv: any, clock?: any) => {
      bridge.invoke("sync:sendSyncRequest", roomId, vv, clock);
    },
    sendSyncResponse: (roomId: string, ops: any[], vv: any, target?: string) => {
      bridge.invoke("sync:sendSyncResponse", roomId, ops, vv, target);
    },
    sendAwareness: (roomId: string, state: AwarenessState) => {
      bridge.invoke("sync:sendAwareness", roomId, state);
    },
    onPageEvents: (callbacks: any) => {
      const unsubs: (() => void)[] = [];
      for (const [event, cb] of Object.entries(callbacks)) {
        if (cb) unsubs.push(bridge.on(`page:${event}`, cb as any));
      }
      return () => unsubs.forEach((u) => u());
    },
    getConnectionState: () => "connected" as const,
    onConnectionChange: (cb: any) => bridge.on("sync:connectionChange", cb),
  };
}

// =============================================================================
// Create Electron Driver
// =============================================================================

export function createElectronDriver(): { driver: Driver; sync: Platform["sync"] } {
  const bridge = getBridge();
  return {
    driver: {
      db: new IpcDbDriver(bridge),
      fs: new IpcFsDriver(bridge),
      basePath: "", // Main process resolves paths relative to workspace
    },
    sync: createElectronSync(bridge),
  };
}
