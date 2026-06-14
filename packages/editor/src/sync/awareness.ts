/**
 * Awareness Module
 *
 * Manages presence and cursor awareness for collaborative editing.
 * Tracks remote users' cursor positions, selections, and user information.
 */

import type { Page } from "../serlization/loadPage";
import type { Position, SelectionState } from "../state-types";
import { isTextualBlock } from "./block-registry";
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
