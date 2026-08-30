import { useCallback, useRef } from "react";
import { getPlatform } from "@/platform";

/**
 * One reversible calendar action.
 *
 * `undo` and `redo` are the two directions of the same edit, and both go
 * through the ordinary page mutations the UI already uses — an undo is a plain
 * forward write, so it reaches peers and rebuilds caches like any other edit.
 * Nothing here touches the editor's own CRDT undo stack: body text typed inside
 * an event's preview stays with the document that owns it.
 */
export interface CalendarUndoEntry {
  /**
   * Complete, already-translated confirmations for each direction. They are
   * shown back to the user because the affected event is often on a day that
   * isn't on screen, and nothing visible would change otherwise. Two whole
   * messages rather than one composed from fragments: a sentence assembled at
   * runtime does not survive translation.
   */
  undoMessage: string;
  redoMessage: string;
  /**
   * The page this entry acts on. If it has vanished entirely — a peer removed
   * it while the entry was still on the stack — the entry is dropped instead of
   * writing into nothing.
   */
  pageId?: string;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
}

/** Entries past this depth fall off the bottom of the stack. */
const DEFAULT_LIMIT = 25;

/**
 * Whether the page is still a meaningful undo target. Archived counts: undoing
 * an archive is exactly the case where the page is not live.
 */
async function pageStillExists(id: string): Promise<boolean> {
  const platform = getPlatform();
  try {
    await platform.pages.get(id);
    return true;
  } catch {
    // `pages.get` filters archived rows out, so an archived page lands here.
    try {
      return !!(await platform.pages.getArchived(id));
    } catch {
      return false;
    }
  }
}

/**
 * An undo history for calendar-level edits — moves, resizes, creations,
 * duplications, archives, reschedules — scoped to the component that calls it.
 * The stacks live in refs: nothing renders from them, so recording an action
 * must not cost a re-render on every drag.
 */
export function useCalendarUndo(limit: number = DEFAULT_LIMIT) {
  const undoStack = useRef<CalendarUndoEntry[]>([]);
  const redoStack = useRef<CalendarUndoEntry[]>([]);
  // Undo and redo run async writes; a second keystroke mid-flight would pop a
  // stack that the first one is still working through.
  const running = useRef(false);

  const record = useCallback(
    (entry: CalendarUndoEntry) => {
      const stack = undoStack.current;
      stack.push(entry);
      if (stack.length > limit) stack.splice(0, stack.length - limit);
      // A fresh action invalidates whatever was waiting to be redone.
      redoStack.current = [];
    },
    [limit],
  );

  const clear = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
  }, []);

  const run = useCallback(
    async (
      from: React.RefObject<CalendarUndoEntry[]>,
      to: React.RefObject<CalendarUndoEntry[]>,
      direction: "undo" | "redo",
    ): Promise<CalendarUndoEntry | null> => {
      if (running.current) return null;
      running.current = true;
      try {
        // Skip past entries whose page is gone rather than stopping at them:
        // one dead event should not block undo of everything under it.
        while (from.current.length > 0) {
          const entry = from.current.pop()!;
          if (entry.pageId && !(await pageStillExists(entry.pageId))) continue;
          await (direction === "undo" ? entry.undo() : entry.redo());
          to.current.push(entry);
          return entry;
        }
        return null;
      } finally {
        running.current = false;
      }
    },
    [],
  );

  const undo = useCallback(
    () => run(undoStack, redoStack, "undo"),
    [run],
  );
  const redo = useCallback(
    () => run(redoStack, undoStack, "redo"),
    [run],
  );

  return { record, undo, redo, clear };
}
