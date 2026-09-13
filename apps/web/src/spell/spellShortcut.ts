/**
 * The desktop spelling chords, as a pure predicate so the listener in
 * `SpellcheckLayer` and its test share one definition.
 *
 * Cmd/Ctrl+.        → fix-or-next (open suggestions for the word at the caret,
 *                     else jump to the next misspelled word and open them).
 * Shift+Cmd/Ctrl+.  → the previous misspelled word.
 *
 * Matched on `code` so Arabic and other non-Latin layouts reach the same key.
 * Alt is never part of the chord (Alt+. is a dead key on some layouts). The
 * command modifier is exclusive: on Apple a bare Ctrl+. is left to the OS.
 */
export type SpellShortcut = "fixOrNext" | "prev";

export interface SpellShortcutEvent {
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export function spellShortcutFor(
  e: SpellShortcutEvent,
  apple: boolean,
): SpellShortcut | null {
  if (e.code !== "Period" || e.altKey) return null;
  const isCmd = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!isCmd) return null;
  return e.shiftKey ? "prev" : "fixOrNext";
}

/** Printed form of the fix-or-next chord, one keycap per entry. */
export function spellShortcutKeys(apple: boolean): readonly string[] {
  return [apple ? "⌘" : "Ctrl", "."];
}
