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

/** Predefined colors for remote users (all unique) */
const AWARENESS_COLORS = [
  "#ff5789", // pink
  "#ff7301", // orange
  "#0365d6", // blue
  "#10b981", // green
  "#8b5cf6", // purple
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
];

/** Test names for remote users */
const TEST_NAMES = [
  "Alice",
  "Bob",
  "Charlie",
  "Diana",
  "Eve",
  "Frank",
  "Grace",
  "Henry",
];

/** Track assigned colors and names per peer */
const assignedColors = new Map<string, string>();
const assignedNames = new Map<string, string>();
const usedColorIndices = new Set<number>();
const usedNameIndices = new Set<number>();

/**
 * Get a random unused index from an array, or random if all used.
 */
function getRandomUnusedIndex(
  usedIndices: Set<number>,
  arrayLength: number
): number {
  // Find available indices
  const availableIndices: number[] = [];
  for (let i = 0; i < arrayLength; i++) {
    if (!usedIndices.has(i)) {
      availableIndices.push(i);
    }
  }

  // If all are used, pick randomly from all and reset tracking
  if (availableIndices.length === 0) {
    usedIndices.clear();
    return Math.floor(Math.random() * arrayLength);
  }

  // Pick randomly from available
  const randomIdx = Math.floor(Math.random() * availableIndices.length);
  return availableIndices[randomIdx];
}

/**
 * Get a color for a peer ID.
 * Assigns randomly from unused colors, avoiding repetition until all are used.
 */
export function getColorForPeer(peerId: string): string {
  // Return existing assignment if peer already has a color
  const existing = assignedColors.get(peerId);
  if (existing) return existing;

  // Get a random unused color
  const index = getRandomUnusedIndex(usedColorIndices, AWARENESS_COLORS.length);
  usedColorIndices.add(index);

  const color = AWARENESS_COLORS[index];
  assignedColors.set(peerId, color);
  return color;
}

/**
 * Get a test name for a peer ID.
 * Assigns randomly from unused names, avoiding repetition until all are used.
 */
export function getTestNameForPeer(peerId: string): string {
  // Return existing assignment if peer already has a name
  const existing = assignedNames.get(peerId);
  if (existing) return existing;

  // Get a random unused name
  const index = getRandomUnusedIndex(usedNameIndices, TEST_NAMES.length);
  usedNameIndices.add(index);

  const name = TEST_NAMES[index];
  assignedNames.set(peerId, name);
  return name;
}

/**
 * Clear assignment for a peer (call when peer leaves).
 */
export function clearPeerAssignment(peerId: string): void {
  const color = assignedColors.get(peerId);
  if (color) {
    const colorIndex = AWARENESS_COLORS.indexOf(color);
    if (colorIndex !== -1) usedColorIndices.delete(colorIndex);
    assignedColors.delete(peerId);
  }

  const name = assignedNames.get(peerId);
  if (name) {
    const nameIndex = TEST_NAMES.indexOf(name);
    if (nameIndex !== -1) usedNameIndices.delete(nameIndex);
    assignedNames.delete(peerId);
  }
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
        clearPeerAssignment(peerId);
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
