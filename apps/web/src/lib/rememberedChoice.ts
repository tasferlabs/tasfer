/**
 * The last value someone picked in a control, kept per device.
 *
 * A picker's last choice is a convenience rather than a preference the person
 * set, and it is about the machine they work on, so it lives in `localStorage`
 * and is never replicated to their other devices or to co-members of a space.
 */

const PREFIX = "tasfer:remember:";

/** Keys shared by more than one control, so both ends stay in step. */
export const REMEMBER_KEYS = {
  /** Target space of an import, whether picked in a dialog or on a file drop. */
  importSpace: "import-space",
  /** Space a new calendar event is drafted into. */
  eventSpace: "event-space",
  /**
   * Whether the event draft's parent picker shows its "Recent" shortcut row.
   * Someone who always files from the tree can fold it away for good.
   */
  recentParents: "calendar-recent-parents",
  /** Whether that same picker shows the page tree it drills through. */
  parentTree: "calendar-parent-tree",
} as const;

/**
 * The remembered value for `key`, or undefined. `allowed` drops a value whose
 * option is gone — a deleted space, a removed choice — so a stale id never
 * outranks the caller's own default.
 */
export function getRememberedChoice(
  key: string,
  allowed?: readonly string[],
): string | undefined {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(PREFIX + key);
  } catch {
    // localStorage unavailable (private mode) — nothing is remembered.
    return undefined;
  }
  if (!stored) return undefined;
  return !allowed || allowed.includes(stored) ? stored : undefined;
}

export function rememberChoice(key: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // A choice that cannot be stored simply is not remembered.
  }
}
