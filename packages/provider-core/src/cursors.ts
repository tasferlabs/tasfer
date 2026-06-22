/**
 * @cypherkit/provider-core/cursors — remote cursors & selections as editor
 * decorations.
 *
 * The editor engine has no concept of "presence" or "peers": it paints generic
 * {@link Decoration}s fed in via `editor.view.setDecorations(layer, …)`. This module
 * is the bridge — it maps a peer's {@link CursorPresence} (the cursor/selection
 * shape a host publishes through a provider's presence channel) to decorations,
 * and {@link bindPresenceCursors} wires both directions for a {@link Provider}.
 *
 * Two layers, so non-provider hosts can reuse the hard part:
 *   - **pure mappers** ({@link cursorPresenceToDecorations},
 *     {@link selectionToCursorPresence}) + {@link getColorForPeer} — transport
 *     agnostic; a host syncing presence over its own pipe can call these
 *     directly and feed the result to `editor.view.setDecorations`.
 *   - **{@link bindPresenceCursors}** — the convenience binder for a Provider:
 *     publishes the local selection on every `selectionchange`, and turns every
 *     remote peer's presence into a `presence:<peerId>` decoration layer.
 */

import type { Decoration, DocRange, Editor, Page } from "@cypherkit/editor";
import type { Position, SelectionState } from "@cypherkit/editor/state-types";
import type { Presence, Provider, RemotePresence } from "./types";

// =============================================================================
// Per-peer color
// =============================================================================

/**
 * Default palette for remote-user colors. A host can pass its own list to
 * {@link getColorForPeer}; exported so it can be extended rather than replaced.
 */
export const DEFAULT_AWARENESS_COLORS: readonly string[] = [
  "#ff5789", // pink
  "#ff7301", // orange
  "#0365d6", // blue
  "#8b5cf6", // purple
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash; // 32-bit
  }
  return Math.abs(hash);
}

/**
 * Deterministic color for a key (peer id or name) from `palette` — the same key
 * always gets the same color.
 */
export function getColorForPeer(
  key: string,
  palette: readonly string[] = DEFAULT_AWARENESS_COLORS,
): string {
  const colors = palette.length > 0 ? palette : DEFAULT_AWARENESS_COLORS;
  return colors[hashString(key) % colors.length];
}

// =============================================================================
// Awareness — a richer presence shape (block-id anchored cursor + selection +
// identity) that a host can broadcast over its own transport. Lives here, not in
// the editor: the engine has no presence concept, it only paints decorations.
// =============================================================================

/** Identity + appearance for a peer's awareness. */
export interface AwarenessUser {
  readonly peerId: string;
  readonly name?: string;
  readonly avatar?: string | null;
  readonly color: string;
  readonly deviceType?: string;
}

/** A cursor position addressed by stable block id. */
export interface AwarenessCursor {
  readonly blockId: string;
  readonly textIndex: number;
}

/** A selection range addressed by stable block ids. */
export interface AwarenessSelection {
  readonly anchor: AwarenessCursor;
  readonly focus: AwarenessCursor;
  readonly isForward: boolean;
}

/** A peer's complete awareness payload. */
export interface AwarenessState {
  readonly user: AwarenessUser;
  readonly cursor: AwarenessCursor | null;
  readonly selection: AwarenessSelection | null;
  readonly lastUpdate: number;
}

/** Convert an editor {@link Position} to a block-id-anchored awareness cursor. */
export function positionToAwarenessCursor(
  position: Position,
  page: Page,
): AwarenessCursor | null {
  const block = page.blocks[position.blockIndex];
  if (!block || block.deleted) return null;
  return { blockId: block.id, textIndex: position.textIndex };
}

/** Convert an editor {@link SelectionState} to a block-id-anchored selection. */
export function selectionToAwarenessSelection(
  selection: SelectionState,
  page: Page,
): AwarenessSelection | null {
  const anchor = positionToAwarenessCursor(selection.anchor, page);
  const focus = positionToAwarenessCursor(selection.focus, page);
  if (!anchor || !focus) return null;
  return { anchor, focus, isForward: selection.isForward };
}

/** A stable point: CRDT block id + offset into that block's text. */
export interface CursorPoint {
  readonly block: string;
  readonly offset: number;
}

/** Identity + appearance a host publishes alongside its cursor. */
export interface CursorUser {
  readonly peerId: string;
  readonly name?: string;
  readonly avatar?: string | null;
  /** Explicit color; falls back to a deterministic per-peer color. */
  readonly color?: string;
}

/**
 * The presence payload for remote-cursor display — what a host publishes through
 * `provider.presence.set(...)`. A collaborator with a non-empty selection sends
 * `selection`; a plain caret sends `caret`.
 */
export interface CursorPresence {
  readonly user: CursorUser;
  readonly caret: CursorPoint | null;
  readonly selection: { readonly from: CursorPoint; readonly to: CursorPoint } | null;
}

/** Default translucency for a remote peer's selection fill. */
const REMOTE_SELECTION_OPACITY = 0.3;

/**
 * Map a peer's presence to the decorations that render it: a selection fill when
 * the peer has a selection, otherwise a labeled caret. Pure — feed the result to
 * `editor.view.setDecorations("presence:<peerId>", …)`.
 */
export function cursorPresenceToDecorations(
  peerId: string,
  presence: CursorPresence,
): Decoration[] {
  const color = presence.user.color || getColorForPeer(peerId);

  if (presence.selection) {
    return [
      {
        kind: "range",
        range: presence.selection,
        color,
        opacity: REMOTE_SELECTION_OPACITY,
      },
    ];
  }

  if (presence.caret) {
    return [
      {
        kind: "caret",
        point: presence.caret,
        color,
        label: presence.user.name
          ? { text: presence.user.name, avatar: presence.user.avatar ?? null }
          : undefined,
      },
    ];
  }

  return [];
}

/**
 * Build a {@link CursorPresence} from an editor's current selection (a
 * {@link DocRange}, as returned by `editor.getSelection()`) plus the local
 * user's identity. A collapsed selection (bare point) becomes a caret; a span
 * becomes a selection.
 */
export function selectionToCursorPresence(
  selection: DocRange | null,
  user: CursorUser,
): CursorPresence {
  if (selection && typeof selection === "object" && "from" in selection) {
    const { from, to } = selection;
    if (isAbsolutePoint(from) && isAbsolutePoint(to)) {
      return { user, caret: null, selection: { from, to } };
    }
  }
  if (isAbsolutePoint(selection)) {
    return { user, caret: selection, selection: null };
  }
  return { user, caret: null, selection: null };
}

function isAbsolutePoint(p: unknown): p is CursorPoint {
  return (
    typeof p === "object" &&
    p !== null &&
    "block" in p &&
    typeof (p as { block: unknown }).block === "string" &&
    "offset" in p &&
    typeof (p as { offset: unknown }).offset === "number"
  );
}

const presenceLayer = (peerId: string) => `presence:${peerId}`;

/** Options for {@link bindPresenceCursors}. */
export interface BindPresenceCursorsOptions {
  /** Local user identity broadcast with the cursor. */
  readonly user: CursorUser;
  /**
   * Hide a peer's cursor after this many ms with no update (still connected but
   * idle). Defaults to 10s; pass `0` to disable idle-hiding.
   */
  readonly idleTimeout?: number;
}

/**
 * Wire a {@link Provider}'s presence channel to an editor's decorations so
 * remote carets/selections render automatically — and the local selection is
 * published on every change. Returns an unsubscribe that detaches both
 * directions and clears every presence layer it added.
 */
export function bindPresenceCursors(
  editor: Editor,
  provider: Provider,
  options: BindPresenceCursorsOptions,
): () => void {
  const { user, idleTimeout = 10000 } = options;
  const presence: Presence = provider.presence;

  // Outbound: publish the local selection as presence.
  const publish = () => {
    presence.set(
      selectionToCursorPresence(editor.getSelection(), user) as unknown as Record<
        string,
        unknown
      >,
    );
  };
  publish();
  const offSelection = editor.on("selectionchange", publish);

  // Inbound: each remote peer's presence becomes a decoration layer.
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const shownPeers = new Set<string>();

  const clearPeer = (peerId: string) => {
    editor.view.clearDecorations(presenceLayer(peerId));
    shownPeers.delete(peerId);
    const timer = idleTimers.get(peerId);
    if (timer) clearTimeout(timer);
    idleTimers.delete(peerId);
  };

  const applyPeers = (peers: RemotePresence[]) => {
    const live = new Set<string>();
    for (const { peerId, state } of peers) {
      live.add(peerId);
      const decorations = cursorPresenceToDecorations(
        peerId,
        state as unknown as CursorPresence,
      );
      editor.view.setDecorations(presenceLayer(peerId), decorations);
      shownPeers.add(peerId);

      const prev = idleTimers.get(peerId);
      if (prev) clearTimeout(prev);
      if (idleTimeout > 0) {
        idleTimers.set(
          peerId,
          setTimeout(() => clearPeer(peerId), idleTimeout),
        );
      }
    }
    // Drop peers that left (no longer in the presence list).
    for (const peerId of [...shownPeers]) {
      if (!live.has(peerId)) clearPeer(peerId);
    }
  };

  const offPresence = presence.on("change", applyPeers);
  applyPeers(presence.getRemote());

  return () => {
    offSelection();
    offPresence();
    for (const peerId of [...shownPeers]) clearPeer(peerId);
  };
}
