/**
 * Electron Driver
 *
 * Delegates database and filesystem operations to the Electron main process
 * via IPC. The main process uses better-sqlite3 and node:fs.
 * Networking uses WebRTC (same as web/mobile — Electron is Chromium).
 *
 * This is just the thin driver — all business logic is in Engine.
 */

import type { Driver, DbDriver, DbRow, DbRunResult, FsDriver, CryptoDriver } from "../driver";
import { createWebRtcNetworkDriver } from "./webrtc";

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
// IPC Crypto Driver
// =============================================================================

class IpcCryptoDriver implements CryptoDriver {
  private bridge: ElectronBridge;
  constructor(bridge: ElectronBridge) {
    this.bridge = bridge;
  }

  async generateKeypair(): Promise<{ publicKey: string; privateKey: string }> {
    return (await this.bridge.invoke("crypto:generateKeypair")) as {
      publicKey: string;
      privateKey: string;
    };
  }

  async sign(privateKey: string, message: Uint8Array): Promise<string> {
    return (await this.bridge.invoke("crypto:sign", privateKey, message.buffer)) as string;
  }

  async verify(publicKey: string, signature: string, message: Uint8Array): Promise<boolean> {
    return (await this.bridge.invoke("crypto:verify", publicKey, signature, message.buffer)) as boolean;
  }
}

// =============================================================================
// Create Electron Driver
// =============================================================================

export function createElectronDriver(signalUrl: string): Driver {
  const bridge = getBridge();
  return {
    db: new IpcDbDriver(bridge),
    fs: new IpcFsDriver(bridge),
    crypto: new IpcCryptoDriver(bridge),
    network: createWebRtcNetworkDriver(signalUrl),
    basePath: "", // Main process resolves paths relative to workspace
  };
}
