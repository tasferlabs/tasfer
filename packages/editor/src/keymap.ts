import { isApplePlatform } from "./platform";

/**
 * The built-in commands a key chord can be rebound to. These are the editor's
 * own chords — formatting, history, selection, the contextual menu. Typing and
 * caret keys (arrows, Enter, Backspace, Tab, the macOS ⌃A/⌃E set) and the
 * native clipboard chords are not commands: they stay fixed.
 */
export type KeymapCommand =
  | "toggleStrong"
  | "toggleEmphasis"
  | "toggleCode"
  | "toggleStrike"
  | "undo"
  | "redo"
  | "selectAll"
  | "expandSelection"
  | "shrinkSelection"
  | "openContextMenu";

/** Every command, with the chords that run it. */
export type Keymap = Readonly<Record<KeymapCommand, readonly string[]>>;

/**
 * A host's changes to the {@link defaultKeymap}: each listed command takes these
 * chords instead of its defaults. An empty list unbinds the command; an unlisted
 * command keeps its defaults.
 */
export type KeymapOverrides = Partial<Keymap>;

export const KEYMAP_COMMANDS: readonly KeymapCommand[] = [
  "toggleStrong",
  "toggleEmphasis",
  "toggleCode",
  "toggleStrike",
  "undo",
  "redo",
  "selectAll",
  "expandSelection",
  "shrinkSelection",
  "openContextMenu",
];

/**
 * The chords the editor answers out of the box, written in the shortcut syntax
 * {@link matchesShortcut} reads. `mod` is ⌘ on Apple and Ctrl elsewhere, which
 * covers everything but the selection ladder: that one follows each platform's
 * code editors, ⌃⇧⌘→ on Apple and Shift+Alt+→ elsewhere.
 */
export function defaultKeymap(apple: boolean = isApplePlatform()): Keymap {
  return {
    toggleStrong: ["mod+b"],
    toggleEmphasis: ["mod+i"],
    toggleCode: ["mod+e"],
    toggleStrike: ["mod+shift+x"],
    undo: ["mod+z"],
    redo: ["mod+shift+z", "mod+y"],
    selectAll: ["mod+a"],
    expandSelection: [
      apple ? "mod+ctrl+shift+arrowright" : "alt+shift+arrowright",
    ],
    shrinkSelection: [
      apple ? "mod+ctrl+shift+arrowleft" : "alt+shift+arrowleft",
    ],
    openContextMenu: ["mod+enter", "shift+f10", "contextmenu"],
  };
}

/** The command a keydown runs under `overrides` laid over the defaults. */
export function keymapCommandFor(
  overrides: KeymapOverrides,
  e: ShortcutEvent,
): KeymapCommand | null {
  const apple = isApplePlatform();
  const defaults = defaultKeymap(apple);
  for (const command of KEYMAP_COMMANDS) {
    const chords = overrides[command] ?? defaults[command];
    if (chords.some((chord) => matchesShortcut(e, chord, apple))) {
      return command;
    }
  }
  return null;
}

/** The parts of a `KeyboardEvent` a chord is matched on. */
export type ShortcutEvent = Pick<
  KeyboardEvent,
  "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
> & { key?: string };

// Punctuation tokens and the physical key each one names. Matching the code
// rather than the character keeps a chord on the same key under any layout:
// ⌘; is `ك` on an Arabic keyboard and `ö` on a German one.
const PUNCTUATION_CODES: Readonly<Record<string, string>> = {
  ";": "Semicolon",
  ".": "Period",
  ",": "Comma",
  "/": "Slash",
  "\\": "Backslash",
  "[": "BracketLeft",
  "]": "BracketRight",
  "'": "Quote",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
};

const CODE_TOKENS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PUNCTUATION_CODES).map(([token, code]) => [code, token]),
);

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "OS"]);

/**
 * The `KeyboardEvent.code` a shortcut token denotes — `"b"` → `"KeyB"`, `"1"` →
 * `"Digit1"`, `";"` → `"Semicolon"`, `"space"` → `"Space"`. Null for named keys
 * ("enter", "arrowright", "f10"), which are matched on `KeyboardEvent.key`.
 */
function keyCodeFor(token: string): string | null {
  if (/^[a-z]$/.test(token)) return `Key${token.toUpperCase()}`;
  if (/^[0-9]$/.test(token)) return `Digit${token}`;
  if (token === "space") return "Space";
  return PUNCTUATION_CODES[token] ?? null;
}

interface ParsedShortcut {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * Read a chord like `"mod+shift+b"`. Modifier tokens are `mod` (⌘ on Apple,
 * Ctrl elsewhere), `ctrl`/`control`, `meta`/`cmd`, `alt`/`opt`/`option` and
 * `shift`; the last token is the key. Null for an empty chord or an unknown
 * modifier.
 */
export function parseShortcut(chord: string): ParsedShortcut | null {
  const parts = chord
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const parsed: ParsedShortcut = {
    key,
    mod: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
  };
  for (const part of parts) {
    if (part === "mod") parsed.mod = true;
    else if (part === "ctrl" || part === "control") parsed.ctrl = true;
    else if (part === "meta" || part === "cmd" || part === "action")
      parsed.meta = true;
    else if (part === "alt" || part === "opt" || part === "option")
      parsed.alt = true;
    else if (part === "shift") parsed.shift = true;
    else return null;
  }
  return parsed;
}

/**
 * Whether a keydown is exactly this chord: the same modifiers, no more, and the
 * same key. Letters, digits and punctuation compare the physical key
 * (`KeyboardEvent.code`), so ⌘B still fires on an Arabic layout, where the key
 * types `ب`; named keys compare `KeyboardEvent.key`.
 */
export function matchesShortcut(
  e: ShortcutEvent,
  chord: string,
  apple: boolean = isApplePlatform(),
): boolean {
  const parsed = parseShortcut(chord);
  if (!parsed) return false;
  const wantCtrl = parsed.ctrl || (parsed.mod && !apple);
  const wantMeta = parsed.meta || (parsed.mod && apple);
  if (e.ctrlKey !== wantCtrl || e.metaKey !== wantMeta) return false;
  if (e.altKey !== parsed.alt || e.shiftKey !== parsed.shift) return false;
  const code = keyCodeFor(parsed.key);
  if (code) return code === e.code || e.key?.toLowerCase() === parsed.key;
  return e.key?.toLowerCase() === parsed.key;
}

/**
 * The chord a keydown spells, in the canonical form {@link matchesShortcut}
 * reads — for recording a new shortcut from a key press. Modifiers come first,
 * in the order `mod`, `ctrl`, `meta`, `alt`, `shift`, and the platform's command
 * key is written `mod`, so a chord recorded on a Mac also works on Windows. Null
 * while only modifiers are down.
 */
export function shortcutFromEvent(
  e: ShortcutEvent & { key: string },
  apple: boolean = isApplePlatform(),
): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (e.code === "Space") key = "space";
  else if (CODE_TOKENS[e.code]) key = CODE_TOKENS[e.code];
  else if (e.key && e.key !== "Unidentified" && e.key !== "Dead")
    key = e.key.toLowerCase();
  else return null;
  const parts: string[] = [];
  if (apple ? e.metaKey : e.ctrlKey) parts.push("mod");
  if (apple && e.ctrlKey) parts.push("ctrl");
  if (!apple && e.metaKey) parts.push("meta");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/**
 * A chord rewritten in canonical form, so two spellings of the same keys —
 * `"Shift+Mod+B"` and `"mod+shift+b"` — compare equal. Null when unreadable.
 */
export function normalizeShortcut(
  chord: string,
  apple: boolean = isApplePlatform(),
): string | null {
  const parsed = parseShortcut(chord);
  if (!parsed) return null;
  const ctrl = parsed.ctrl || (parsed.mod && !apple);
  const meta = parsed.meta || (parsed.mod && apple);
  const parts: string[] = [];
  if (apple ? meta : ctrl) parts.push("mod");
  if (apple && ctrl) parts.push("ctrl");
  if (!apple && meta) parts.push("meta");
  if (parsed.alt) parts.push("alt");
  if (parsed.shift) parts.push("shift");
  parts.push(parsed.key === " " ? "space" : parsed.key);
  return parts.join("+");
}
