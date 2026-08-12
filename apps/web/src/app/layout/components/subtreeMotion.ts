/**
 * Timing of the sidebar subtree reveal. Shared by the row that animates it and
 * by the drop zone that springs a page open mid-drag and has to wait for the
 * rows below to settle before dnd-kit re-measures them.
 */

/** Matches the sidebar's own resize curve so panel motion stays consistent. */
export const SUBTREE_EASE = [0.32, 0.72, 0, 1] as const;

export const SUBTREE_MOTION_MS = 180;
