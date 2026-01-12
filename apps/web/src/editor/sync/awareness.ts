/**
 * Awareness Module
 *
 * Manages presence and cursor awareness for collaborative editing.
 * Tracks remote users' cursor positions, selections, and user information.
 */

import type { Page } from "@/deserializer/loadPage";
import type { Position, SelectionState } from "../../editor/types";

// =============================================================================
// Types
// =============================================================================

/** User information for awareness */
export interface AwarenessUser {
  /** Unique peer ID */
  readonly peerId: string;
  /** Display name (optional) */
  readonly name?: string;
  /** User color for cursor/selection highlighting */
  readonly color: string;
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

/** Predefined colors for remote users */
const AWARENESS_COLORS = ["#ff5789", "#ff7301", "#0365d6", "#ff7301"];

/** Test names for remote users */
const TEST_NAMES = ["Alice", "Bob", "Charlie", "Diana"];

/**
 * Generate a consistent color for a peer ID.
 * Uses a simple hash to ensure the same peer always gets the same color.
 */
export function getColorForPeer(peerId: string): string {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash << 5) - hash + peerId.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return AWARENESS_COLORS[Math.abs(hash) % AWARENESS_COLORS.length];
}

/**
 * Generate a consistent test name for a peer ID.
 * Uses the same hash algorithm as color assignment for consistency.
 */
export function getTestNameForPeer(peerId: string): string {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash << 5) - hash + peerId.charCodeAt(i);
    hash = hash & hash;
  }
  return TEST_NAMES[Math.abs(hash) % TEST_NAMES.length];
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

  /** Stale timeout in ms - remote states older than this are considered stale */
  private staleTimeout = 30000; // 30 seconds
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: AwarenessConfig) {
    this.config = config;
    this.localUser = {
      peerId: config.peerId,
      name: config.userName,
      color: getColorForPeer(config.peerId),
    };

    // Start cleanup interval for stale states
    this.cleanupInterval = setInterval(() => this.cleanupStaleStates(), 10000);
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
   * Get all remote awareness states.
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
      this.notifyUpdate();
    }
  }

  /**
   * Clear all remote awareness states.
   */
  clearRemoteStates(): void {
    if (this.remoteStates.size > 0) {
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
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.remoteStates.clear();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private notifyUpdate(): void {
    this.config.onRemoteUpdate?.(this.getRemoteStates());
  }

  private cleanupStaleStates(): void {
    const now = Date.now();
    let hasChanges = false;

    for (const [peerId, state] of this.remoteStates) {
      if (now - state.lastUpdate > this.staleTimeout) {
        this.remoteStates.delete(peerId);
        hasChanges = true;
      }
    }

    if (hasChanges) {
      this.notifyUpdate();
    }
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
  page: Page
): AwarenessCursor | null {
  const block = page.blocks[position.blockIndex];
  if (!block) return null;

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
  page: Page
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
  page: Page
): Position | null {
  const blockIndex = page.blocks.findIndex((b) => b.id === cursor.blockId);
  if (blockIndex === -1) return null;

  const block = page.blocks[blockIndex];

  // Clamp text index to valid range
  let textIndex = cursor.textIndex;
  if ("chars" in block && block.chars) {
    // Count non-deleted characters
    const visibleLength = block.chars.filter((c) => !c.deleted).length;
    textIndex = Math.min(textIndex, visibleLength);
  } else {
    textIndex = 0;
  }

  return {
    blockIndex,
    textIndex: Math.max(0, textIndex),
  };
}

/**
 * Convert AwarenessSelection to editor SelectionState.
 * Returns null if any block no longer exists.
 */
export function awarenessSelectionToSelection(
  awareness: AwarenessSelection,
  page: Page
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
// Factory
// =============================================================================

/**
 * Create an AwarenessManager instance.
 */
export function createAwarenessManager(
  config: AwarenessConfig
): AwarenessManager {
  return new AwarenessManager(config);
}
