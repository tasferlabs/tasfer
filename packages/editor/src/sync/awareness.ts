/**
 * Awareness Module
 *
 * Manages presence and cursor awareness for collaborative editing.
 * Tracks remote users' cursor positions, selections, and user information.
 */

import type { Page } from "../serlization/loadPage";
import { isTextualBlock } from "../serlization/loadPage";
import type { Position, SelectionState } from "../state-types";
import { getVisibleLengthFromRuns } from "./char-runs";

// =============================================================================
// Types
// =============================================================================

/** User information for awareness */
export interface AwarenessUser {
  /** Unique peer ID */
  readonly peerId: string;
  /** Display name (optional) */
  readonly name?: string;
  /** Avatar image ID (optional) */
  readonly avatar?: string | null;
  /** User color for cursor/selection highlighting */
  readonly color: string;
  /** Device type (optional) */
  readonly deviceType?: string;
}

/** Cursor position in awareness (uses block ID for stability) */
export interface AwarenessCursor {
  readonly blockId: string;
  readonly textIndex: number;
}

/** Selection range in awareness */
export interface AwarenessSelection {
  readonly anchor: AwarenessCursor;
  readonly focus: AwarenessCursor;
  readonly isForward: boolean;
}

/** Complete awareness state for a peer */
export interface AwarenessState {
  readonly user: AwarenessUser;
  readonly cursor: AwarenessCursor | null;
  readonly selection: AwarenessSelection | null;
  readonly lastUpdate: number;
}

/** Local awareness state (what we broadcast) */
export interface LocalAwarenessState {
  readonly cursor: AwarenessCursor | null;
  readonly selection: AwarenessSelection | null;
}

// =============================================================================
// Color Generation
// =============================================================================

/** Predefined colors for remote users (all unique) */
const AWARENESS_COLORS = [
  "#ff5789", // pink
  "#ff7301", // orange
  "#0365d6", // blue
  // "#10b981", // green
  "#8b5cf6", // purple
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
];

/**
 * Simple hash function for strings.
 * Produces a consistent numeric hash for deterministic color/name assignment.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Get a color for a given key (user name or peer ID).
 * Uses deterministic hashing so the same key always gets the same color.
 */
export function getColorForPeer(key: string): string {
  const index = hashString(key) % AWARENESS_COLORS.length;
  return AWARENESS_COLORS[index];
}

/**
 * Clear assignment for a peer (call when peer leaves).
 * No-op since assignments are now deterministic based on peer ID.
 */
export function clearPeerAssignment(_peerId: string): void {
  // No-op: colors and names are now derived deterministically from peer ID
  // so there's nothing to clear
}

// =============================================================================
// Awareness Manager
// =============================================================================

export interface AwarenessConfig {
  /** Local peer ID */
  peerId: string;
  /** Local user name (optional) */
  userName?: string;
  /** Called when remote awareness states change */
  onRemoteUpdate?: (states: Map<string, AwarenessState>) => void;
}

/**
 * AwarenessManager tracks local and remote user presence/cursor states.
 *
 * @example
 * const awareness = new AwarenessManager({
 *   peerId: "abc123",
 *   userName: "Alice",
 *   onRemoteUpdate: (states) => {
 *     // Render remote cursors
 *   },
 * });
 *
 * // Update local state
 * awareness.setLocalState({
 *   cursor: { blockId: "b-abc:1", textIndex: 5 },
 *   selection: null,
 * });
 *
 * // Apply remote state
 * awareness.setRemoteState("peer456", {
 *   user: { peerId: "peer456", name: "Bob", color: "#60A5FA" },
 *   cursor: { blockId: "b-abc:1", textIndex: 10 },
 *   selection: null,
 *   lastUpdate: Date.now(),
 * });
 */
export class AwarenessManager {
  private config: AwarenessConfig;
  private localState: LocalAwarenessState = { cursor: null, selection: null };
  private remoteStates: Map<string, AwarenessState> = new Map();
  private localUser: AwarenessUser;

  constructor(config: AwarenessConfig) {
    this.config = config;
    this.localUser = {
      peerId: config.peerId,
      name: config.userName,
      color: getColorForPeer(config.userName || config.peerId),
    };
  }

  /**
   * Get the local user info.
   */
  getLocalUser(): AwarenessUser {
    return this.localUser;
  }

  /**
   * Get the current local awareness state.
   */
  getLocalState(): LocalAwarenessState {
    return this.localState;
  }

  /**
   * Get all remote awareness states (includes idle peers).
   */
  getRemoteStates(): Map<string, AwarenessState> {
    return new Map(this.remoteStates);
  }

  /**
   * Get a specific remote peer's awareness state.
   */
  getRemoteState(peerId: string): AwarenessState | undefined {
    return this.remoteStates.get(peerId);
  }

  /**
   * Update the local awareness state.
   * Returns the full awareness state to broadcast.
   */
  setLocalState(state: LocalAwarenessState): AwarenessState {
    this.localState = state;
    return {
      user: this.localUser,
      cursor: state.cursor,
      selection: state.selection,
      lastUpdate: Date.now(),
    };
  }

  /**
   * Update a remote peer's awareness state.
   */
  setRemoteState(peerId: string, state: AwarenessState): void {
    // Don't track our own state
    if (peerId === this.config.peerId) return;

    this.remoteStates.set(peerId, state);
    this.notifyUpdate();
  }

  /**
   * Remove a remote peer's awareness state (e.g., when they leave).
   */
  removeRemoteState(peerId: string): void {
    if (this.remoteStates.delete(peerId)) {
      clearPeerAssignment(peerId);
      this.notifyUpdate();
    }
  }

  /**
   * Clear all remote awareness states.
   */
  clearRemoteStates(): void {
    if (this.remoteStates.size > 0) {
      for (const peerId of this.remoteStates.keys()) {
        clearPeerAssignment(peerId);
      }
      this.remoteStates.clear();
      this.notifyUpdate();
    }
  }

  /**
   * Update local user name.
   */
  setUserName(name: string): void {
    this.localUser = { ...this.localUser, name };
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.remoteStates.clear();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private notifyUpdate(): void {
    this.config.onRemoteUpdate?.(this.getRemoteStates());
  }
}

// =============================================================================
// Position Conversion Utilities
// =============================================================================

/**
 * Convert editor Position to AwarenessCursor.
 * Uses block ID for stability across concurrent operations.
 */
export function positionToAwarenessCursor(
  position: Position,
  page: Page,
): AwarenessCursor | null {
  const block = page.blocks[position.blockIndex];
  if (!block || block.deleted) return null;

  return {
    blockId: block.id,
    textIndex: position.textIndex,
  };
}

/**
 * Convert editor SelectionState to AwarenessSelection.
 */
export function selectionToAwarenessSelection(
  selection: SelectionState,
  page: Page,
): AwarenessSelection | null {
  const anchorCursor = positionToAwarenessCursor(selection.anchor, page);
  const focusCursor = positionToAwarenessCursor(selection.focus, page);

  if (!anchorCursor || !focusCursor) return null;

  return {
    anchor: anchorCursor,
    focus: focusCursor,
    isForward: selection.isForward,
  };
}

/**
 * Convert AwarenessCursor to editor Position.
 * Returns null if the block no longer exists.
 */
export function awarenessCursorToPosition(
  cursor: AwarenessCursor,
  page: Page,
): Position | null {
  const blockIndex = page.blocks.findIndex((b) => b.id === cursor.blockId);
  if (blockIndex === -1) return null;

  const block = page.blocks[blockIndex];
  if (!block || block.deleted) return null;

  // Clamp text index to valid range
  let textIndex = cursor.textIndex;
  if (isTextualBlock(block) && block.charRuns) {
    // Count non-deleted characters
    const visibleLength = getVisibleLengthFromRuns(block.charRuns);
    textIndex = Math.min(textIndex, visibleLength);
  } else {
    textIndex = 0;
  }

  return {
    blockIndex: blockIndex,
    textIndex: Math.max(0, textIndex),
  };
}

/**
 * Convert AwarenessSelection to editor SelectionState.
 * Returns null if any block no longer exists.
 */
export function awarenessSelectionToSelection(
  awareness: AwarenessSelection,
  page: Page,
): SelectionState | null {
  const anchor = awarenessCursorToPosition(awareness.anchor, page);
  const focus = awarenessCursorToPosition(awareness.focus, page);

  if (!anchor || !focus) return null;

  const isCollapsed =
    anchor.blockIndex === focus.blockIndex &&
    anchor.textIndex === focus.textIndex;

  return {
    anchor,
    focus,
    isForward: awareness.isForward,
    isCollapsed,
  };
}

// =============================================================================
// Comparison Utilities
// =============================================================================

/**
 * Compare two awareness cursors for equality by value.
 */
export function awarenessCursorsEqual(
  a: AwarenessCursor | null,
  b: AwarenessCursor | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.blockId === b.blockId && a.textIndex === b.textIndex;
}

/**
 * Compare two awareness selections for equality by value.
 */
export function awarenessSelectionsEqual(
  a: AwarenessSelection | null,
  b: AwarenessSelection | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    awarenessCursorsEqual(a.anchor, b.anchor) &&
    awarenessCursorsEqual(a.focus, b.focus) &&
    a.isForward === b.isForward
  );
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an AwarenessManager instance.
 */
export function createAwarenessManager(
  config: AwarenessConfig,
): AwarenessManager {
  return new AwarenessManager(config);
}
