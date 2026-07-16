/**
 * useCollaborativeDoc — owns a page's CRDT `Doc` and ALL of its collaboration and
 * persistence, hoisted ABOVE the editor so any number of editor surfaces (the
 * body {@link PageEditor}, a title/preview editor) can attach to the one doc with
 * sync wired exactly ONCE.
 *
 * Everything here is doc-scoped, needing no editor: creating the doc (with this
 * tab's persistent peer id + the app schema), joining the P2P room, broadcasting
 * local ops + persisting them, applying remote ops, requesting sync on join, and
 * writing the FS snapshot. What stays with the editor is view/authoring work —
 * rendering, the toolbar, and presence (which reads the editor's selection and
 * paints remote cursors); this hook only exposes the awareness *transport* those
 * surfaces publish/subscribe through.
 *
 * The owner mounts this via a wrapper keyed per page (see `CollaborativeEditor`
 * in `MountedEditor`), so a page switch tears the doc down and rebuilds it — the
 * child editor unmounts first, so the editor is always destroyed before the doc.
 */

import {
  createDoc,
  serializeVV,
  type Block,
  type Doc,
  type Operation,
} from "@tasfer/editor";
import { cleanSnapshotForSave } from "@tasfer/editor/internal";
import type {
  CursorPresence,
  CursorUser,
} from "@tasfer/provider-core/cursors";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { getPlatform } from "@/platform";
import { appSchema } from "../editorSchema";
import type { AppSchemaDefinition } from "../editorSchema";
import { useP2PRoom, type SyncState } from "./hooks/useP2PRoom";

/**
 * The surface's remote-presence handlers, installed via {@link AwarenessChannel}.
 * The hook routes the room's awareness/join events to whichever surface is
 * currently connected (the primary body editor), which renders them as cursors.
 */
export interface AwarenessHandlers {
  /** A single peer's presence changed (or `null` when they left). */
  onUpdate: (peerId: string, state: CursorPresence | null) => void;
  /** A full snapshot of every peer's presence (on join / room-peers). */
  onStates: (states: Record<string, CursorPresence>) => void;
  /** A new peer joined — re-publish our own cursor so they see it. */
  onPeerJoined: (peerId: string) => void;
  /** We (re)joined a room that already has peers — re-publish our cursor. */
  onRejoin: () => void;
}

/**
 * The awareness transport a surface uses to publish its own cursor and subscribe
 * to peers'. Only one surface (the primary body editor) connects at a time.
 */
export interface AwarenessChannel {
  /** Publish this surface's cursor/selection to the room. */
  broadcast: (state: CursorPresence) => void;
  /** Install the surface's presence handlers; returns an unsubscribe. */
  connect: (handlers: AwarenessHandlers) => () => void;
}

/** The shared doc + collaboration handles handed down to editor surfaces. */
export interface CollaborativeDoc {
  /** The shared CRDT document — the single source of truth for the page. */
  doc: Doc<AppSchemaDefinition>;
  /** Awareness transport for presence (publish local, subscribe to peers). */
  awareness: AwarenessChannel;
  /** This tab's identity + cursor color, or a blank placeholder until it loads. */
  localUser: CursorUser;
  /** This tab's CRDT replica / presence id. */
  peerId: string;
  /**
   * Resolves once persisted ops have loaded and the doc's version vector is
   * accurate. Resolves immediately in readonly mode (nothing is loaded). Surfaces
   * gate their loading spinner on this.
   */
  opsLoaded: Promise<void>;
}

export interface UseCollaborativeDocOptions {
  /** Page id — the CRDT doc id and the P2P room id. */
  pageId: string;
  /** Owning space id, so P2P sync uses the correct replication topic. */
  spaceId?: string;
  /** Initial blocks the doc is seeded with (overridden by HMR live content). */
  snapshot: Block[];
  /** View-only: join the room for presence/status, but never edit/persist/sync. */
  readonly: boolean;
  /** Notified of connection/sync status changes (drives the host's indicator). */
  onSyncStateChange?: (state: SyncState) => void;
}

/**
 * Create and own a page's collaborative {@link Doc}. Mount through a wrapper keyed
 * per page so the doc is recreated on a page switch (and reused across HMR).
 */
export function useCollaborativeDoc({
  pageId,
  spaceId,
  snapshot,
  readonly,
  onSyncStateChange,
}: UseCollaborativeDocOptions): CollaborativeDoc {
  // Preserve live doc content across HMR re-mounts (refs survive Fast Refresh);
  // a genuine page switch keys a fresh instance, so this starts null there.
  const liveBlocksRef = useRef<{ blocks: Block[]; pageId: string } | null>(
    null,
  );
  const docRef = useRef<Doc<AppSchemaDefinition> | null>(null);

  // Room callback refs, set by the effects below (ops) or by `awareness.connect`
  // (presence). Held in refs so wiring them never re-joins the room.
  const onRoomOperationsRef = useRef<((ops: Operation[]) => void) | null>(null);
  const onRoomSyncResponseRef = useRef<
    ((ops: Operation[], vv: Record<string, number>) => void) | null
  >(null);
  const onRoomJoinedRef = useRef<((hasOtherPeers: boolean) => void) | null>(
    null,
  );
  const awarenessHandlersRef = useRef<AwarenessHandlers | null>(null);

  const {
    broadcast: roomBroadcast,
    broadcastAwareness: roomBroadcastAwareness,
    sendSyncRequest: roomSendSyncRequest,
    syncState,
    localUser,
    peerId,
  } = useP2PRoom(
    pageId,
    {
      onOperations: useCallback((ops: Operation[]) => {
        onRoomOperationsRef.current?.(ops);
      }, []),
      onSyncResponse: useCallback(
        (ops: Operation[], vv: Record<string, number>) => {
          onRoomSyncResponseRef.current?.(ops, vv);
        },
        [],
      ),
      onPeerJoined: useCallback((pId: string) => {
        awarenessHandlersRef.current?.onPeerJoined(pId);
      }, []),
      onAwarenessUpdate: useCallback(
        (pId: string, state: CursorPresence | null) => {
          awarenessHandlersRef.current?.onUpdate(pId, state);
        },
        [],
      ),
      onAwarenessStates: useCallback(
        (states: Record<string, CursorPresence>) => {
          awarenessHandlersRef.current?.onStates(states);
        },
        [],
      ),
      onJoined: useCallback((hasOtherPeers: boolean) => {
        onRoomJoinedRef.current?.(hasOtherPeers);
      }, []),
    },
    spaceId,
  );

  const peerIdRef = useRef(peerId);
  peerIdRef.current = peerId;

  // Create the doc exactly once, in the render phase, so it is available
  // synchronously to the editor the child mounts. It carries this tab's
  // persistent peer id (so local ops stay causally ours across reloads) and the
  // app's explicit schema. HMR: reuse live content for the same page.
  if (!docRef.current) {
    const initialBlocks =
      liveBlocksRef.current?.pageId === pageId
        ? liveBlocksRef.current.blocks
        : snapshot;
    liveBlocksRef.current = null;
    docRef.current = createDoc({
      blocks: initialBlocks,
      pageId,
      peerId: peerIdRef.current,
      schema: appSchema.data,
    });
  }
  const doc = docRef.current;

  // A resolvable promise for "persisted ops loaded" (VV accurate). Created once.
  const opsLoadedRef = useRef<{ promise: Promise<void>; resolve: () => void }>(
    null as unknown as { promise: Promise<void>; resolve: () => void },
  );
  if (!opsLoadedRef.current) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    opsLoadedRef.current = { promise, resolve };
  }

  // Notify the host of connection/sync status changes.
  useEffect(() => {
    onSyncStateChange?.(syncState);
  }, [syncState, onSyncStateChange]);

  // The awareness transport handed to the surface. Stable across renders.
  const awareness = useMemo<AwarenessChannel>(
    () => ({
      broadcast: (state: CursorPresence) => roomBroadcastAwareness(state),
      connect: (handlers: AwarenessHandlers) => {
        awarenessHandlersRef.current = handlers;
        return () => {
          if (awarenessHandlersRef.current === handlers) {
            awarenessHandlersRef.current = null;
          }
        };
      },
    }),
    [roomBroadcastAwareness],
  );

  // Own the doc's lifetime. Declared BEFORE the collaboration effect so, on
  // unmount, its cleanup runs LAST (effect cleanups run in reverse order) — after
  // that effect has unsubscribed from `doc.on("update")`, so we never touch the
  // doc after destroying it. As a passive cleanup it also runs after the child
  // editor's layout-phase teardown, so the editor is destroyed before the doc. We
  // stash the final blocks for HMR reuse just before destroying, while the doc is
  // still alive.
  useEffect(() => {
    return () => {
      liveBlocksRef.current = { blocks: doc.getRawBlocks(), pageId };
      doc.destroy();
      docRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Collaboration + persistence wiring. Doc-scoped (no editor needed), so it runs
  // as soon as the doc exists. Mount-once: the owner keys this per page, so
  // pageId/readonly are constant for the lifetime of this instance.
  useEffect(() => {
    if (readonly) {
      // View-only: the room is still joined (status + presence for viewers), but
      // we never broadcast, persist, or apply ops. Nothing loads, so surfaces can
      // reveal immediately.
      opsLoadedRef.current.resolve();
      return;
    }

    const platform = getPlatform();

    // Running clock-based version vector of every op the doc holds, used as the
    // FS snapshot's validity token. Folded from the same ops that mutate the doc
    // (seeded from the loaded log, then advanced per update) so it describes
    // exactly the op set the snapshot blocks reflect. Maintained incrementally.
    const clockVV: Record<string, number> = {};
    const foldClockVV = (ops: Operation[]) => {
      for (const op of ops) {
        const peer = op.clock.peerId;
        if (op.clock.counter > (clockVV[peer] ?? -1)) {
          clockVV[peer] = op.clock.counter;
        }
      }
    };

    // Debounced snapshot writer — keeps the FS snapshot in sync after edits.
    // 2s delay avoids writing on every keystroke.
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    const saveSnapshot = (blocks: Block[]) => {
      if (snapshotTimer) clearTimeout(snapshotTimer);
      // Strip the transient render cache (`cachedLayout`) the editor writes onto
      // the doc's canonical blocks before persisting: it holds live Mark
      // instances whose codec functions can't cross the platform's structured-
      // clone boundary (postMessage), and it's per-canvas-width render state that
      // is invalid to persist anyway.
      const clean = cleanSnapshotForSave(blocks);
      // Snapshot the token by value now; clockVV keeps mutating as later edits
      // arrive, but this write must carry the frontier matching `clean`.
      const vv = { ...clockVV };
      snapshotTimer = setTimeout(() => {
        platform.snapshots.save(pageId, clean, vv);
      }, 2000);
    };

    // Single fan-out for every document change. Local edits (u.local) are
    // broadcast to peers and persisted to SQLite here; remote ops are persisted
    // by the Replicator before they reach applyUpdate, so we only refresh the FS
    // snapshot for those. The doc's update event also drives the editor re-render
    // (via the editor's doc↔editor wiring), so there's no second fold.
    const offDocUpdate = doc.on("update", (u) => {
      if (u.local) {
        roomBroadcast(u.ops);
        platform.ops.persist(pageId, u.ops);
      }
      // Advance the token before snapshotting so it covers this batch's ops.
      foldClockVV(u.ops);
      saveSnapshot(doc.getRawBlocks());
    });

    // Apply remote ops through the doc. applyUpdate dedups via the version
    // vector, advances the shared binding past everything received (so local ops
    // stay causally ahead), drives the editor, and fires offDocUpdate — all
    // synchronously.
    const applyRemoteOps = (ops: Operation[]) => {
      doc.applyUpdate(ops, "remote");
    };

    onRoomOperationsRef.current = applyRemoteOps;
    onRoomSyncResponseRef.current = (ops) => {
      if (ops.length > 0) applyRemoteOps(ops);
    };

    // Load persisted operations from SQLite (if any) and register them on the
    // doc. This catches the doc's version vector + clock/id counter up to what
    // the snapshot blocks already represent (the blocks were rebuilt from these
    // ops by the engine), without re-rendering — see Doc.load. New local ops then
    // out-order and out-counter historical ones.
    const opsLoadedPromise = platform.ops
      .load(pageId)
      .then((persistedOps) => {
        if (persistedOps.length > 0 && docRef.current) {
          docRef.current.load(persistedOps);
          // Seed the snapshot token: load() registers these ops without emitting
          // an update, so they never reach the fold in the update handler.
          foldClockVV(persistedOps);
        }
      })
      .finally(() => {
        opsLoadedRef.current.resolve();
      });

    // Handle room join/rejoin — request VV-based sync from peers, then let the
    // surface re-publish its awareness so peers see our cursor.
    onRoomJoinedRef.current = (hasOtherPeers) => {
      if (hasOtherPeers) {
        // Wait for persisted ops to load so the VV is accurate.
        opsLoadedPromise.then(() => {
          roomSendSyncRequest(serializeVV(doc.getVersionVector()));
        });
        awarenessHandlersRef.current?.onRejoin();
      }
    };

    return () => {
      offDocUpdate();
      onRoomOperationsRef.current = null;
      onRoomSyncResponseRef.current = null;
      onRoomJoinedRef.current = null;
      if (snapshotTimer) clearTimeout(snapshotTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    doc,
    awareness,
    localUser,
    peerId,
    opsLoaded: opsLoadedRef.current.promise,
  };
}
