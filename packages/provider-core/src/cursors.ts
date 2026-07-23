/**
 * @tasfer/provider-core/cursors — remote cursors & selections as editor
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
 *     publishes the local selection whenever the caret moves (both
 *     `selectionchange` and content `change` events), and turns every remote
 *     peer's presence into a `presence:<peerId>` decoration layer.
 */

import type {
  ContentPoint,
  ContentSelection,
  Decoration,
  DocRange,
  Editor,
  LabelIconShape,
} from "@tasfer/editor";
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
// Presence — a stable flat or structured cursor/selection + identity a host
// broadcasts over its own transport. Lives here, not in the editor: the engine
// has no presence concept, it only paints decorations.
// =============================================================================

/** A stable point in a block's flat text. */
export interface FlatCursorPoint {
  readonly block: string;
  readonly offset: number;
}

/** Presence may point into flat text or extension-owned structured content. */
export type CursorPoint = FlatCursorPoint | ContentPoint;

/** Identity + appearance a host publishes alongside its cursor. */
export interface CursorUser {
  readonly peerId: string;
  readonly name?: string;
  readonly avatar?: string | null;
  /** Explicit color; falls back to a deterministic per-peer color. */
  readonly color?: string;
  /** Optional device hint (e.g. "laptop"/"phone") for a presence UI. */
  readonly deviceType?: string;
  /**
   * Stable id of the originating person/device, shared across all of that
   * person's tabs/replicas (unlike {@link peerId}, which is per-tab). Lets a
   * presence UI recognize the local user's own other tabs and label them
   * accordingly (e.g. "You") instead of as a separate anonymous peer.
   */
  readonly deviceId?: string;
}

/**
 * Last-resort label for a peer with no display name. A raw peer id (a random
 * hex string) is never shown as a name — anonymous peers get this friendly
 * default instead. Hosts should pass their own localized string to
 * {@link getDisplayName}; this constant is only the English fallback.
 */
export const DEFAULT_USER_NAME = "Anonymous";

/**
 * A peer's display name for presence UI: their chosen name if set, otherwise a
 * friendly fallback — never the raw peer id. Pass a localized `fallback` (e.g.
 * the i18next translation of "Anonymous") at the host's display boundary.
 */
export function getDisplayName(
  user: { readonly name?: string },
  fallback: string = DEFAULT_USER_NAME,
): string {
  const name = user.name?.trim();
  return name ? name : fallback;
}

/**
 * Whether `user`'s presence comes from the same person/device as
 * `selfDeviceId` (the local user's {@link CursorUser.deviceId}) — i.e. the
 * local user's own other tab/replica. False when either id is missing, so an
 * unknown peer is never mistaken for the local user.
 */
export function isSamePerson(
  user: { readonly deviceId?: string },
  selfDeviceId: string | null | undefined,
): boolean {
  return !!selfDeviceId && user.deviceId === selfDeviceId;
}

/**
 * The presence payload for remote-cursor display — what a host publishes through
 * `provider.presence.set(...)`. A collaborator with a non-empty selection sends
 * `selection`; a plain caret sends `caret`.
 */
export interface CursorPresence {
  readonly user: CursorUser;
  readonly caret: CursorPoint | null;
  readonly selection: {
    readonly from: CursorPoint;
    readonly to: CursorPoint;
  } | null;
}

/** Default translucency for a remote peer's selection fill. */
const REMOTE_SELECTION_OPACITY = 0.3;

/**
 * Map a peer's presence to the decorations that render it: a selection fill when
 * the peer has a selection, otherwise a labeled caret. Pure — feed the result to
 * `editor.view.setDecorations("presence:<peerId>", …)`.
 *
 * `labelIcon` attaches a glyph to the caret label. It exists so a host can fold
 * cross-peer context into the label — e.g. a device hint to tell two same-named
 * collaborators apart — without this mapper having to know anything about the
 * other peers or what the glyph depicts.
 */
export function cursorPresenceToDecorations(
  peerId: string,
  presence: CursorPresence,
  defaultName?: string,
  labelIcon?: readonly LabelIconShape[],
): Decoration[] {
  // Presence is whatever a peer published — the protocol only routes it, it
  // does not validate the shape. A peer with no `user` (or a hostile one) must
  // render nothing, not throw: the caller loops over every peer, so one bad
  // payload would otherwise break cursor rendering for the whole room.
  if (!isCursorPresence(presence)) return [];

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
        label: {
          text: getDisplayName(presence.user, defaultName),
          avatar: presence.user.avatar ?? null,
          icon: labelIcon,
        },
      },
    ];
  }

  return [];
}

/**
 * Build a {@link CursorPresence} from the editor's flat and structured selection
 * snapshots plus the local user's identity. Structured selection takes
 * precedence while math or another attached editor owns the caret.
 */
export function selectionToCursorPresence(
  selection: DocRange | null,
  user: CursorUser,
  contentSelection: ContentSelection | null = null,
): CursorPresence {
  if (contentSelection) {
    if (
      contentPointsAtSameStop(contentSelection.anchor, contentSelection.focus)
    ) {
      return { user, caret: contentSelection.focus, selection: null };
    }
    return {
      user,
      caret: null,
      selection: {
        from: contentSelection.anchor,
        to: contentSelection.focus,
      },
    };
  }
  if (selection && typeof selection === "object" && "from" in selection) {
    const { from, to } = selection;
    if (isFlatCursorPoint(from) && isFlatCursorPoint(to)) {
      return { user, caret: null, selection: { from, to } };
    }
  }
  if (isFlatCursorPoint(selection)) {
    return { user, caret: selection, selection: null };
  }
  return { user, caret: null, selection: null };
}

function contentPointsAtSameStop(
  left: ContentPoint,
  right: ContentPoint,
): boolean {
  if (left.kind === "text" && right.kind === "text") {
    return (
      left.blockId === right.blockId &&
      left.contentId === right.contentId &&
      left.nodeId === right.nodeId &&
      left.field === right.field &&
      left.afterCharId === right.afterCharId
    );
  }
  if (left.kind === "gap" && right.kind === "gap") {
    return (
      left.blockId === right.blockId &&
      left.contentId === right.contentId &&
      left.parentId === right.parentId &&
      left.slot === right.slot &&
      left.afterNodeId === right.afterNodeId
    );
  }
  return false;
}

function isFlatCursorPoint(p: unknown): p is FlatCursorPoint {
  return (
    typeof p === "object" &&
    p !== null &&
    "block" in p &&
    typeof (p as { block: unknown }).block === "string" &&
    "offset" in p &&
    typeof (p as { offset: unknown }).offset === "number"
  );
}

function isContentPoint(p: unknown): p is ContentPoint {
  if (typeof p !== "object" || p === null || !("kind" in p)) return false;
  const point = p as Partial<ContentPoint> & Record<string, unknown>;
  if (
    (point.kind !== "text" && point.kind !== "gap") ||
    typeof point.blockId !== "string" ||
    typeof point.contentId !== "string" ||
    (point.affinity !== "backward" && point.affinity !== "forward")
  ) {
    return false;
  }
  if (point.kind === "text") {
    return (
      typeof point.nodeId === "string" &&
      typeof point.field === "string" &&
      (point.afterCharId === null || typeof point.afterCharId === "string")
    );
  }
  return (
    typeof point.parentId === "string" &&
    typeof point.slot === "string" &&
    (point.afterNodeId === null || typeof point.afterNodeId === "string")
  );
}

function isCursorPoint(p: unknown): p is CursorPoint {
  return isFlatCursorPoint(p) || isContentPoint(p);
}

/**
 * Whether a value published through a provider's presence channel is a
 * {@link CursorPresence} this module can render. Remote peers are untrusted
 * input: `state` is `Record<string, unknown>` on the wire and nothing upstream
 * checks it against this shape.
 */
function isCursorPresence(p: unknown): p is CursorPresence {
  if (typeof p !== "object" || p === null) return false;
  const { user, caret, selection } = p as Partial<CursorPresence>;

  // `getDisplayName` trims `name`; the caret label reads `avatar` and `color`.
  if (typeof user !== "object" || user === null) return false;
  if (user.name !== undefined && typeof user.name !== "string") return false;
  if (user.color !== undefined && typeof user.color !== "string") return false;
  if (
    user.avatar !== undefined &&
    user.avatar !== null &&
    typeof user.avatar !== "string"
  ) {
    return false;
  }

  if (caret != null && !isCursorPoint(caret)) return false;
  if (selection != null) {
    if (typeof selection !== "object") return false;
    if (!isCursorPoint(selection.from) || !isCursorPoint(selection.to)) {
      return false;
    }
    const fromContent = isContentPoint(selection.from);
    const toContent = isContentPoint(selection.to);
    if (fromContent !== toContent) return false;
    if (
      fromContent &&
      toContent &&
      (selection.from.blockId !== selection.to.blockId ||
        selection.from.contentId !== selection.to.contentId)
    ) {
      return false;
    }
  }
  return true;
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
 * published whenever the caret moves (caret-only `selectionchange` *and*
 * content `change` events, so a peer's cursor follows their typing). Returns an
 * unsubscribe that detaches both directions and clears every presence layer it
 * added.
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
      selectionToCursorPresence(
        editor.state.selection.range,
        user,
        editor.state.contentSelection,
      ) as unknown as Record<string, unknown>,
    );
  };
  publish();
  const offSelection = editor.on("selectionchange", publish);
  // Typing moves the caret but the engine reports it as a "change" (content)
  // event, not "selectionchange" (caret moves with no content change). Publish
  // on both so a peer's cursor follows their typing instead of freezing until
  // their next click/selection. `publish` ignores the event arg and re-reads the
  // live selection, so it's correct for content changes too (including a remote
  // insert before the caret, which shifts the offset peers need to see).
  const offChange = editor.on("change", publish);

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
    offChange();
    offPresence();
    for (const peerId of [...shownPeers]) clearPeer(peerId);
  };
}
