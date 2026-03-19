/**
 * Capacitor Platform Adapter (iOS / Android)
 *
 * Uses Capacitor plugins for native capabilities:
 * - @capacitor-community/sqlite for SQLite
 * - @capacitor/filesystem for file storage
 * - WebRTC for P2P sync (or relay fallback)
 */

import type { Platform } from "../types";

export class CapacitorPlatform implements Platform {
  identity = {
    async get() {
      throw new Error("TODO: capacitor identity");
    },
    async update() {
      throw new Error("TODO: capacitor identity update");
    },
  } as Platform["identity"];

  peers = {
    async list() {
      throw new Error("TODO: capacitor peers");
    },
    async trust() {
      throw new Error("TODO: capacitor peers trust");
    },
    async untrust() {
      throw new Error("TODO: capacitor peers untrust");
    },
    async remove() {
      throw new Error("TODO: capacitor peers remove");
    },
  } as Platform["peers"];

  pages = {
    async list() {
      throw new Error("TODO: capacitor pages list");
    },
    async get() {
      throw new Error("TODO: capacitor pages get");
    },
    async create() {
      throw new Error("TODO: capacitor pages create");
    },
    async update() {
      throw new Error("TODO: capacitor pages update");
    },
    async delete() {
      throw new Error("TODO: capacitor pages delete");
    },
    async move() {
      throw new Error("TODO: capacitor pages move");
    },
    async reorder() {
      throw new Error("TODO: capacitor pages reorder");
    },
    async search() {
      throw new Error("TODO: capacitor pages search");
    },
    async calendar() {
      throw new Error("TODO: capacitor pages calendar");
    },
    async snapshots() {
      throw new Error("TODO: capacitor pages snapshots");
    },
  } as Platform["pages"];

  assets = {
    async store() {
      throw new Error("TODO: capacitor assets store");
    },
    getUrl() {
      throw new Error("TODO: capacitor assets getUrl");
    },
    async delete() {
      throw new Error("TODO: capacitor assets delete");
    },
  } as Platform["assets"];

  sync = {
    async joinRoom() {
      throw new Error("TODO: capacitor sync joinRoom");
    },
    async leaveRoom() {
      throw new Error("TODO: capacitor sync leaveRoom");
    },
    sendOperations() {
      throw new Error("TODO: capacitor sync sendOperations");
    },
    sendSyncRequest() {
      throw new Error("TODO: capacitor sync sendSyncRequest");
    },
    sendSyncResponse() {
      throw new Error("TODO: capacitor sync sendSyncResponse");
    },
    sendAwareness() {
      throw new Error("TODO: capacitor sync sendAwareness");
    },
    onPageEvents() {
      throw new Error("TODO: capacitor sync onPageEvents");
    },
    getConnectionState() {
      return "disconnected" as const;
    },
    onConnectionChange() {
      return () => {};
    },
  } as Platform["sync"];

  storage = {
    async get() {
      throw new Error("TODO: capacitor storage get");
    },
    async set() {
      throw new Error("TODO: capacitor storage set");
    },
    async remove() {
      throw new Error("TODO: capacitor storage remove");
    },
  } as Platform["storage"];
}
