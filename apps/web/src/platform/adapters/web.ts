/**
 * Web Platform Adapter
 *
 * Runs in the browser with no native capabilities.
 * Uses IndexedDB for storage, WebRTC for P2P sync.
 * This is the current behavior — wrapping existing API calls.
 */

import type { Platform } from "../types";

export class WebPlatform implements Platform {
  identity = {
    async get() {
      throw new Error("TODO: web identity");
    },
    async update() {
      throw new Error("TODO: web identity update");
    },
  } as Platform["identity"];

  peers = {
    async list() {
      throw new Error("TODO: web peers");
    },
    async trust() {
      throw new Error("TODO: web peers trust");
    },
    async untrust() {
      throw new Error("TODO: web peers untrust");
    },
    async remove() {
      throw new Error("TODO: web peers remove");
    },
  } as Platform["peers"];

  pages = {
    async list() {
      throw new Error("TODO: web pages list");
    },
    async get() {
      throw new Error("TODO: web pages get");
    },
    async create() {
      throw new Error("TODO: web pages create");
    },
    async update() {
      throw new Error("TODO: web pages update");
    },
    async delete() {
      throw new Error("TODO: web pages delete");
    },
    async move() {
      throw new Error("TODO: web pages move");
    },
    async reorder() {
      throw new Error("TODO: web pages reorder");
    },
    async search() {
      throw new Error("TODO: web pages search");
    },
    async calendar() {
      throw new Error("TODO: web pages calendar");
    },
    async snapshots() {
      throw new Error("TODO: web pages snapshots");
    },
  } as Platform["pages"];

  assets = {
    async store() {
      throw new Error("TODO: web assets store");
    },
    getUrl() {
      throw new Error("TODO: web assets getUrl");
    },
    async delete() {
      throw new Error("TODO: web assets delete");
    },
  } as Platform["assets"];

  sync = {
    async joinRoom() {
      throw new Error("TODO: web sync joinRoom");
    },
    async leaveRoom() {
      throw new Error("TODO: web sync leaveRoom");
    },
    sendOperations() {
      throw new Error("TODO: web sync sendOperations");
    },
    sendSyncRequest() {
      throw new Error("TODO: web sync sendSyncRequest");
    },
    sendSyncResponse() {
      throw new Error("TODO: web sync sendSyncResponse");
    },
    sendAwareness() {
      throw new Error("TODO: web sync sendAwareness");
    },
    onPageEvents() {
      throw new Error("TODO: web sync onPageEvents");
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
      throw new Error("TODO: web storage get");
    },
    async set() {
      throw new Error("TODO: web storage set");
    },
    async remove() {
      throw new Error("TODO: web storage remove");
    },
  } as Platform["storage"];
}
