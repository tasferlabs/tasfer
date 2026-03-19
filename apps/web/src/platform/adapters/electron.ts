/**
 * Electron Platform Adapter
 *
 * Delegates everything to the main process via IPC.
 * The preload script exposes `window.cypher` with invoke methods.
 * Main process handles: SQLite, filesystem, hyperswarm P2P.
 */

import type { Platform } from "../types";

/** The API exposed by the Electron preload script */
interface ElectronBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): () => void;
}

function getBridge(): ElectronBridge {
  const bridge = (window as any).cypher as ElectronBridge | undefined;
  if (!bridge) throw new Error("Electron bridge not available");
  return bridge;
}

export class ElectronPlatform implements Platform {
  private bridge = getBridge();

  identity = {
    get: () => this.bridge.invoke("identity:get"),
    update: (data: any) => this.bridge.invoke("identity:update", data),
  } as Platform["identity"];

  peers = {
    list: () => this.bridge.invoke("peers:list"),
    trust: (publicKey: string, name?: string) => this.bridge.invoke("peers:trust", publicKey, name),
    untrust: (publicKey: string) => this.bridge.invoke("peers:untrust", publicKey),
    remove: (publicKey: string) => this.bridge.invoke("peers:remove", publicKey),
  } as Platform["peers"];

  pages = {
    list: (parentId?: string | null, options?: any) => this.bridge.invoke("pages:list", parentId, options),
    get: (id: string) => this.bridge.invoke("pages:get", id),
    create: (data: any) => this.bridge.invoke("pages:create", data),
    update: (data: any) => this.bridge.invoke("pages:update", data),
    delete: (id: string) => this.bridge.invoke("pages:delete", id),
    move: (data: any) => this.bridge.invoke("pages:move", data),
    reorder: (id: string, order: number) => this.bridge.invoke("pages:reorder", id, order),
    search: (query: string) => this.bridge.invoke("pages:search", query),
    calendar: (start: number, end: number) => this.bridge.invoke("pages:calendar", start, end),
    snapshots: (pageId: string) => this.bridge.invoke("pages:snapshots", pageId),
  } as Platform["pages"];

  assets = {
    store: async (file: File) => {
      const buffer = await file.arrayBuffer();
      return this.bridge.invoke("assets:store", buffer, file.name, file.type);
    },
    getUrl: (hash: string) => `cypher-asset://${hash}`,
    delete: (hash: string) => this.bridge.invoke("assets:delete", hash),
  } as Platform["assets"];

  sync = {
    joinRoom: (roomId: string, peerId: string, user?: any, callbacks?: any) => {
      // Register callbacks via IPC event listeners
      if (callbacks) {
        for (const [event, cb] of Object.entries(callbacks)) {
          if (cb) this.bridge.on(`sync:${roomId}:${event}`, cb as any);
        }
      }
      return this.bridge.invoke("sync:joinRoom", roomId, peerId, user);
    },
    leaveRoom: (roomId: string) => this.bridge.invoke("sync:leaveRoom", roomId),
    sendOperations: (roomId: string, ops: any[]) => {
      this.bridge.invoke("sync:sendOperations", roomId, ops);
    },
    sendSyncRequest: (roomId: string, vv: any, clock?: any) => {
      this.bridge.invoke("sync:sendSyncRequest", roomId, vv, clock);
    },
    sendSyncResponse: (roomId: string, ops: any[], vv: any, target?: string) => {
      this.bridge.invoke("sync:sendSyncResponse", roomId, ops, vv, target);
    },
    sendAwareness: (roomId: string, state: any) => {
      this.bridge.invoke("sync:sendAwareness", roomId, state);
    },
    onPageEvents: (callbacks: any) => {
      const unsubs: (() => void)[] = [];
      for (const [event, cb] of Object.entries(callbacks)) {
        if (cb) unsubs.push(this.bridge.on(`page:${event}`, cb as any));
      }
      return () => unsubs.forEach((u) => u());
    },
    getConnectionState: () => "connected" as const,
    onConnectionChange: (cb: any) => {
      return this.bridge.on("sync:connectionChange", cb);
    },
  } as Platform["sync"];

  storage = {
    get: (key: string) => this.bridge.invoke("storage:get", key),
    set: (key: string, value: unknown) => this.bridge.invoke("storage:set", key, value),
    remove: (key: string) => this.bridge.invoke("storage:remove", key),
  } as Platform["storage"];
}
