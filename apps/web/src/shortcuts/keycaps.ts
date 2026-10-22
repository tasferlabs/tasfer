import { parseShortcut } from "@tasfer/editor";

// Named keys as their keycaps. Symbols where the platforms agree on one; key
// names stay in English on purpose, as they are printed on the keyboard.
const NAMED_KEYS: Readonly<Record<string, string>> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  enter: "↵",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "⌫",
  delete: "Del",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
  contextmenu: "Menu",
  insert: "Ins",
};

/**
 * A chord as one keycap per key, in each platform's own order and symbols:
 * `mod+shift+b` is ⌘ ⇧ B on a Mac and Ctrl Shift B elsewhere. Drawn by
 * `ShortcutKeys`. Empty for an unreadable chord.
 */
export function shortcutKeycaps(chord: string, apple: boolean): string[] {
  const parsed = parseShortcut(chord);
  if (!parsed) return [];
  const keys = modifierKeycaps(
    {
      ctrlKey: parsed.ctrl || (parsed.mod && !apple),
      metaKey: parsed.meta || (parsed.mod && apple),
      altKey: parsed.alt,
      shiftKey: parsed.shift,
    },
    apple,
  );
  const key = parsed.key;
  keys.push(
    NAMED_KEYS[key] ??
      (/^f\d{1,2}$/.test(key) || key.length === 1 ? key.toUpperCase() : key),
  );
  return keys;
}

/**
 * The modifiers held down, as keycaps in the same order `shortcutKeycaps` uses —
 * what a recorder shows while only modifiers are pressed.
 */
export function modifierKeycaps(
  held: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  apple: boolean,
): string[] {
  const keys: string[] = [];
  if (apple) {
    // macOS menus list modifiers as ⌃ ⌥ ⇧ ⌘.
    if (held.ctrlKey) keys.push("⌃");
    if (held.altKey) keys.push("⌥");
    if (held.shiftKey) keys.push("⇧");
    if (held.metaKey) keys.push("⌘");
  } else {
    if (held.ctrlKey) keys.push("Ctrl");
    if (held.metaKey) keys.push("Win");
    if (held.altKey) keys.push("Alt");
    if (held.shiftKey) keys.push("Shift");
  }
  return keys;
}

/** A chord as plain text for search, e.g. "⌘⇧B" or "Ctrl+Shift+B". */
export function shortcutText(chord: string, apple: boolean): string {
  return shortcutKeycaps(chord, apple).join(apple ? "" : "+");
}
