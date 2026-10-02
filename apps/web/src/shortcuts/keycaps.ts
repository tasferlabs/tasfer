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
  const ctrl = parsed.ctrl || (parsed.mod && !apple);
  const meta = parsed.meta || (parsed.mod && apple);
  const keys: string[] = [];
  if (apple) {
    // macOS menus list modifiers as ⌃ ⌥ ⇧ ⌘.
    if (ctrl) keys.push("⌃");
    if (parsed.alt) keys.push("⌥");
    if (parsed.shift) keys.push("⇧");
    if (meta) keys.push("⌘");
  } else {
    if (ctrl) keys.push("Ctrl");
    if (meta) keys.push("Win");
    if (parsed.alt) keys.push("Alt");
    if (parsed.shift) keys.push("Shift");
  }
  const key = parsed.key;
  keys.push(
    NAMED_KEYS[key] ??
      (/^f\d{1,2}$/.test(key) || key.length === 1 ? key.toUpperCase() : key),
  );
  return keys;
}

/** A chord as plain text for search, e.g. "⌘⇧B" or "Ctrl+Shift+B". */
export function shortcutText(chord: string, apple: boolean): string {
  return shortcutKeycaps(chord, apple).join(apple ? "" : "+");
}
