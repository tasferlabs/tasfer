/**
 * RoomHub — the cross-tab operation bus, server side.
 *
 * In the SharedWorker engine model, every tab is an equal client of one
 * `Engine` and one `Replicator`. But the Replicator keeps a *single* callback
 * set per room (`sync.ts` `RoomState`), so it can't directly serve N tabs that
 * all open the same page. The RoomHub sits in front of it: each tab connection
 * gets its own {@link Sync} facade ({@link RoomHub.connection}), the hub tracks
 * the members of every room, and it fans operations / awareness / presence
 * across the sibling tabs — then delegates to the Replicator for the network.
 *
 * Fan-out is centralized in the node and naturally covers *every* origin —
 * local edits from any tab and (Phase 3) remote edits from the one WebRTC
 * connection — delivered to each open editor exactly once.
 *
 * Presence uses an increment model (`onPeerJoined`/`onPeerLeft`), so
 * `useP2PRoom`'s peer counting and awareness re-broadcast behave as expected.
 * The newcomer gets a baseline `onRoomPeers`
 * (network peers; empty while the network is offline in Phase 2), then learns
 * its sibling tabs via `onPeerJoined`.
 */

import type { Operation } from "@tasfer/editor";
import type { CursorPresence } from "@tasfer/provider-core/cursors";
import type { Platform, SyncEvents, RoomUser } from "../types";

type Sync = Platform["sync"];

interface Member {
  connId: number;
  peerId: string;
  user?: RoomUser;
  callbacks: Partial<SyncEvents>;
}

interface HubRoom {
  spaceId?: string;
  /** connId → member. Insertion order = join order. */
  members: Map<number, Member>;
  /** Whether the underlying Replicator room has been opened. */
  joined: boolean;
}

export class RoomHub {
  /** The single underlying network sync (the Replicator). */
  readonly inner: Sync;
  private readonly rooms = new Map<string, HubRoom>();

  constructor(inner: Sync) {
    this.inner = inner;
  }

  /** Build a per-connection Sync facade to serve to one tab. */
  connection(connId: number): Sync {
    return new ConnectionSync(this, connId);
  }

  // ---------------------------------------------------------------------------
  // Room lifecycle
  // ---------------------------------------------------------------------------

  async joinRoom(
    connId: number,
    roomId: string,
    peerId: string,
    user: RoomUser | undefined,
    callbacks: Partial<SyncEvents>,
    spaceId: string | undefined,
  ): Promise<void> {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { spaceId, members: new Map(), joined: false };
      this.rooms.set(roomId, room);
    }

    const existing = [...room.members.values()];
    const member: Member = { connId, peerId, user, callbacks };
    room.members.set(connId, member);

    // Open the underlying network room once; its remote events fan to members.
    if (!room.joined) {
      room.joined = true;
      await this.inner.joinRoom(
        roomId,
        peerId,
        user,
        this.networkCallbacks(roomId),
        spaceId,
      );
    }

    // Newcomer learns the room population. Baseline (network peers) is empty
    // while the network is offline; siblings are delivered incrementally so
    // peer-count and awareness re-broadcast match the legacy cross-tab path.
    queueMicrotask(() => {
      if (!this.rooms.get(roomId)?.members.has(connId)) return;
      member.callbacks.onRoomPeers?.([], undefined);
      for (const e of existing) member.callbacks.onPeerJoined?.(e.peerId, e.user);
    });

    // Existing tabs learn about the newcomer (and re-broadcast awareness to it).
    for (const e of existing) e.callbacks.onPeerJoined?.(peerId, user);
  }

  async leaveRoom(connId: number, roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    const member = room?.members.get(connId);
    if (!room || !member) return;

    room.members.delete(connId);
    for (const e of room.members.values()) {
      e.callbacks.onPeerLeft?.(member.peerId);
    }

    if (room.members.size === 0) {
      this.rooms.delete(roomId);
      await this.inner.leaveRoom(roomId);
    }
  }

  /** Drop a whole connection (tab closed): leave every room it was in. */
  dropConnection(connId: number): void {
    for (const [roomId, room] of this.rooms) {
      if (room.members.has(connId)) void this.leaveRoom(connId, roomId);
    }
  }

  // ---------------------------------------------------------------------------
  // Fan-out
  // ---------------------------------------------------------------------------

  sendOperations(connId: number, roomId: string, ops: Operation[]): void {
    const room = this.rooms.get(roomId);
    if (room) {
      for (const [id, m] of room.members) {
        if (id !== connId) m.callbacks.onOperations?.(ops);
      }
    }
    this.inner.sendOperations(roomId, ops);
  }

  sendAwareness(connId: number, roomId: string, state: CursorPresence): void {
    const room = this.rooms.get(roomId);
    if (room) {
      const senderPeerId = room.members.get(connId)?.peerId ?? "";
      for (const [id, m] of room.members) {
        if (id !== connId) m.callbacks.onAwareness?.(senderPeerId, state);
      }
    }
    this.inner.sendAwareness(roomId, state);
  }

  /** Callbacks handed to the Replicator: fan its remote events to all members. */
  private networkCallbacks(roomId: string): Partial<SyncEvents> {
    const forEach = (fn: (m: Member) => void): void => {
      const r = this.rooms.get(roomId);
      if (!r) return;
      for (const m of r.members.values()) fn(m);
    };
    const first = (fn: (m: Member) => void): void => {
      const r = this.rooms.get(roomId);
      const m = r?.members.values().next().value;
      if (m) fn(m);
    };
    return {
      onOperations: (ops) => forEach((m) => m.callbacks.onOperations?.(ops)),
      onAwareness: (pid, st) => forEach((m) => m.callbacks.onAwareness?.(pid, st)),
      onPeerJoined: (pid, u) => forEach((m) => m.callbacks.onPeerJoined?.(pid, u)),
      onPeerLeft: (pid) => forEach((m) => m.callbacks.onPeerLeft?.(pid)),
      onRoomPeers: (peers, states) =>
        forEach((m) => m.callbacks.onRoomPeers?.(peers, states)),
      onSyncResponse: (ops, vv) =>
        forEach((m) => m.callbacks.onSyncResponse?.(ops, vv)),
      // Only one tab should answer a remote peer's catch-up request.
      onSyncRequest: (vv, clock, reqId) =>
        first((m) => m.callbacks.onSyncRequest?.(vv, clock, reqId)),
      onError: (msg) => forEach((m) => m.callbacks.onError?.(msg)),
    };
  }
}

/** Per-connection Sync facade: room methods go to the hub, the rest to inner. */
class ConnectionSync implements Sync {
  private readonly hub: RoomHub;
  private readonly connId: number;

  constructor(hub: RoomHub, connId: number) {
    this.hub = hub;
    this.connId = connId;
  }

  joinRoom(
    roomId: string,
    peerId: string,
    user?: RoomUser,
    callbacks?: Partial<SyncEvents>,
    spaceId?: string,
  ): Promise<void> {
    return this.hub.joinRoom(
      this.connId,
      roomId,
      peerId,
      user,
      callbacks ?? {},
      spaceId,
    );
  }

  leaveRoom(roomId: string): Promise<void> {
    return this.hub.leaveRoom(this.connId, roomId);
  }

  sendOperations(roomId: string, operations: Operation[]): void {
    this.hub.sendOperations(this.connId, roomId, operations);
  }

  sendSyncRequest(roomId: string, versionVector: Record<string, number>): void {
    this.hub.inner.sendSyncRequest(roomId, versionVector);
  }

  sendSyncResponse(
    roomId: string,
    operations: Operation[],
    versionVector: Record<string, number>,
    targetPeerId?: string,
  ): void {
    this.hub.inner.sendSyncResponse(
      roomId,
      operations,
      versionVector,
      targetPeerId,
    );
  }

  sendAwareness(roomId: string, state: CursorPresence): void {
    this.hub.sendAwareness(this.connId, roomId, state);
  }

  onPageEvents(callbacks: Parameters<Sync["onPageEvents"]>[0]): () => void {
    return this.hub.inner.onPageEvents(callbacks);
  }

  getConnectionState(): ReturnType<Sync["getConnectionState"]> {
    return this.hub.inner.getConnectionState();
  }

  onConnectionChange(
    cb: Parameters<Sync["onConnectionChange"]>[0],
  ): () => void {
    return this.hub.inner.onConnectionChange(cb);
  }

  getConnectedPeers(): string[] {
    return this.hub.inner.getConnectedPeers();
  }

  onConnectedPeersChange(
    cb: Parameters<Sync["onConnectedPeersChange"]>[0],
  ): () => void {
    return this.hub.inner.onConnectedPeersChange(cb);
  }

  onPeerVersionMismatch(
    cb: Parameters<Sync["onPeerVersionMismatch"]>[0],
  ): () => void {
    return this.hub.inner.onPeerVersionMismatch(cb);
  }
}
