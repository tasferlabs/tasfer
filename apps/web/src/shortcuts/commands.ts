import { defaultKeymap, type KeymapCommand } from "@tasfer/editor";
import type { TFunction } from "i18next";

/** Where a shortcut works — the grid's "Where" column. */
export type ShortcutScope = "general" | "editor" | "calendar" | "desktop";

export interface ShortcutCommand {
  /** Stable id; also the synced pref key's suffix (`shortcut.<id>`). */
  readonly id: string;
  readonly scope: ShortcutScope;
  /** The command's name as the grid shows it. */
  readonly label: (t: TFunction) => string;
  /** The chords it answers until the person changes them. */
  readonly defaults: readonly string[];
  /**
   * Shown for completeness but not changeable: typing and caret keys, the
   * native clipboard chords, and the desktop menu's accelerators.
   */
  readonly locked?: boolean;
  /**
   * Takes a key with no modifier. Only where no text is being typed — the
   * calendar's single letters — so a bare key can never eat a typed character.
   */
  readonly bareKeys?: boolean;
  /** The editor keymap command this drives, for commands the engine runs. */
  readonly keymapCommand?: KeymapCommand;
}

export interface ShortcutEnvironment {
  readonly apple: boolean;
  /** Running in the desktop app, whose menu adds its own accelerators. */
  readonly desktop: boolean;
}

/**
 * Every shortcut in the app, editable or not, in the order the grid lists them.
 * Built per call from the platform, never cached at module scope: the editor
 * defaults come from the engine's own `defaultKeymap`, so the grid and the
 * keymap cannot disagree.
 */
export function shortcutCommands({
  apple,
  desktop,
}: ShortcutEnvironment): ShortcutCommand[] {
  const keymap = defaultKeymap(apple);
  const editor = (
    id: string,
    keymapCommand: KeymapCommand,
    label: (t: TFunction) => string,
    scope: ShortcutScope = "editor",
  ): ShortcutCommand => ({
    id,
    scope,
    label,
    defaults: keymap[keymapCommand],
    keymapCommand,
  });
  const locked = (
    id: string,
    scope: ShortcutScope,
    defaults: readonly string[],
    label: (t: TFunction) => string,
  ): ShortcutCommand => ({ id, scope, label, defaults, locked: true });

  const commands: ShortcutCommand[] = [
    // General
    {
      id: "app.commandPalette",
      scope: "general",
      label: (t) =>
        t("shortcuts.cmd.commandPalette", "Open the command palette"),
      defaults: ["mod+k"],
    },
    {
      id: "app.toggleSidebar",
      scope: "general",
      label: (t) =>
        t("shortcuts.cmd.toggleSidebar", "Show or hide the sidebar"),
      defaults: ["mod+;"],
    },
    editor("undo", "undo", (t) => t("shortcuts.cmd.undo", "Undo"), "general"),
    editor("redo", "redo", (t) => t("shortcuts.cmd.redo", "Redo"), "general"),

    // Editor
    editor("editor.toggleStrong", "toggleStrong", (t) =>
      t("shortcuts.cmd.bold", "Bold"),
    ),
    editor("editor.toggleEmphasis", "toggleEmphasis", (t) =>
      t("shortcuts.cmd.italic", "Italic"),
    ),
    editor("editor.toggleCode", "toggleCode", (t) =>
      t("shortcuts.cmd.inlineCode", "Inline code"),
    ),
    editor("editor.toggleStrike", "toggleStrike", (t) =>
      t("shortcuts.cmd.strikethrough", "Strikethrough"),
    ),
    editor("editor.selectAll", "selectAll", (t) =>
      t("shortcuts.cmd.selectAll", "Select all"),
    ),
    editor("editor.expandSelection", "expandSelection", (t) =>
      t("shortcuts.cmd.expandSelection", "Expand selection"),
    ),
    editor("editor.shrinkSelection", "shrinkSelection", (t) =>
      t("shortcuts.cmd.shrinkSelection", "Shrink selection"),
    ),
    editor("editor.openContextMenu", "openContextMenu", (t) =>
      t("shortcuts.cmd.contextMenu", "Open the menu at the cursor"),
    ),
    {
      id: "editor.find",
      scope: "editor",
      label: (t) => t("shortcuts.cmd.find", "Find in page"),
      defaults: ["mod+f"],
    },
    {
      id: "editor.saveMarkdown",
      scope: "editor",
      label: (t) =>
        t("shortcuts.cmd.saveMarkdown", "Download page as Markdown"),
      defaults: ["mod+s"],
    },
    {
      id: "editor.spellFixOrNext",
      scope: "editor",
      label: (t) =>
        t("shortcuts.cmd.spellFixOrNext", "Fix spelling or go to next mistake"),
      defaults: ["mod+."],
    },
    {
      id: "editor.spellPrevious",
      scope: "editor",
      label: (t) =>
        t("shortcuts.cmd.spellPrevious", "Go to previous spelling mistake"),
      defaults: ["mod+shift+."],
    },
    locked("editor.copy", "editor", ["mod+c"], (t) =>
      t("shortcuts.cmd.copy", "Copy"),
    ),
    locked("editor.cut", "editor", ["mod+x"], (t) =>
      t("shortcuts.cmd.cut", "Cut"),
    ),
    locked("editor.paste", "editor", ["mod+v"], (t) =>
      t("shortcuts.cmd.paste", "Paste"),
    ),
    locked("editor.newBlock", "editor", ["enter"], (t) =>
      t("shortcuts.cmd.newBlock", "Start a new block"),
    ),
    locked("editor.exitBlock", "editor", ["shift+enter"], (t) =>
      t("shortcuts.cmd.exitBlock", "Leave a code block, equation or table"),
    ),
    locked("editor.indent", "editor", ["tab"], (t) =>
      t("shortcuts.cmd.indent", "Indent"),
    ),
    locked("editor.outdent", "editor", ["shift+tab"], (t) =>
      t("shortcuts.cmd.outdent", "Outdent"),
    ),
    locked(
      "editor.wordLeft",
      "editor",
      [apple ? "alt+arrowleft" : "mod+arrowleft"],
      (t) => t("shortcuts.cmd.wordLeft", "Move to previous word"),
    ),
    locked(
      "editor.wordRight",
      "editor",
      [apple ? "alt+arrowright" : "mod+arrowright"],
      (t) => t("shortcuts.cmd.wordRight", "Move to next word"),
    ),
    locked(
      "editor.lineStart",
      "editor",
      apple ? ["mod+arrowleft", "ctrl+a"] : ["home"],
      (t) => t("shortcuts.cmd.lineStart", "Move to start of line"),
    ),
    locked(
      "editor.lineEnd",
      "editor",
      apple ? ["mod+arrowright", "ctrl+e"] : ["end"],
      (t) => t("shortcuts.cmd.lineEnd", "Move to end of line"),
    ),
    locked(
      "editor.documentStart",
      "editor",
      [apple ? "mod+arrowup" : "mod+home"],
      (t) => t("shortcuts.cmd.documentStart", "Move to start of page"),
    ),
    locked(
      "editor.documentEnd",
      "editor",
      [apple ? "mod+arrowdown" : "mod+end"],
      (t) => t("shortcuts.cmd.documentEnd", "Move to end of page"),
    ),
  ];

  // The Cocoa text-view chords every macOS text field answers to.
  if (apple) {
    commands.push(
      locked("editor.emacsBack", "editor", ["ctrl+b"], (t) =>
        t("shortcuts.cmd.charLeft", "Move back one character"),
      ),
      locked("editor.emacsForward", "editor", ["ctrl+f"], (t) =>
        t("shortcuts.cmd.charRight", "Move forward one character"),
      ),
      locked("editor.emacsUp", "editor", ["ctrl+p"], (t) =>
        t("shortcuts.cmd.lineUp", "Move up one line"),
      ),
      locked("editor.emacsDown", "editor", ["ctrl+n"], (t) =>
        t("shortcuts.cmd.lineDown", "Move down one line"),
      ),
      locked("editor.emacsDeleteBackward", "editor", ["ctrl+h"], (t) =>
        t("shortcuts.cmd.deleteBackward", "Delete character before cursor"),
      ),
      locked("editor.emacsDeleteForward", "editor", ["ctrl+d"], (t) =>
        t("shortcuts.cmd.deleteForward", "Delete character after cursor"),
      ),
      locked("editor.emacsKill", "editor", ["ctrl+k"], (t) =>
        t("shortcuts.cmd.deleteToLineEnd", "Delete to end of line"),
      ),
    );
  }

  // Calendar — single keys, since nothing is being typed there.
  const calendar = (
    id: string,
    key: string,
    label: (t: TFunction) => string,
  ): ShortcutCommand => ({
    id,
    scope: "calendar",
    label,
    defaults: [key],
    bareKeys: true,
  });
  commands.push(
    calendar("calendar.previous", "p", (t) =>
      t("shortcuts.cmd.calendarPrevious", "Previous day or week"),
    ),
    calendar("calendar.next", "n", (t) =>
      t("shortcuts.cmd.calendarNext", "Next day or week"),
    ),
    calendar("calendar.today", "t", (t) =>
      t("shortcuts.cmd.calendarToday", "Go to today"),
    ),
    calendar("calendar.newEvent", "c", (t) =>
      t("shortcuts.cmd.calendarNewEvent", "New page on the calendar"),
    ),
    calendar("calendar.dayView", "1", (t) =>
      t("shortcuts.cmd.calendarDayView", "Day view"),
    ),
    calendar("calendar.weekView", "2", (t) =>
      t("shortcuts.cmd.calendarWeekView", "Week view"),
    ),
  );

  // The desktop menu's accelerators belong to Electron's built-in menu roles.
  if (desktop) {
    commands.push(
      locked("desktop.reload", "desktop", ["mod+r"], (t) =>
        t("menu.reload", "Reload"),
      ),
      locked("desktop.forceReload", "desktop", ["mod+shift+r"], (t) =>
        t("menu.forceReload", "Force Reload"),
      ),
      locked(
        "desktop.toggleDevTools",
        "desktop",
        [apple ? "mod+alt+i" : "mod+shift+i"],
        (t) => t("menu.toggleDevTools", "Toggle Developer Tools"),
      ),
      locked("desktop.resetZoom", "desktop", ["mod+0"], (t) =>
        t("menu.resetZoom", "Reset Zoom"),
      ),
      locked("desktop.zoomIn", "desktop", ["mod+="], (t) =>
        t("menu.zoomIn", "Zoom In"),
      ),
      locked("desktop.zoomOut", "desktop", ["mod+-"], (t) =>
        t("menu.zoomOut", "Zoom Out"),
      ),
      locked(
        "desktop.fullscreen",
        "desktop",
        [apple ? "mod+ctrl+f" : "f11"],
        (t) => t("menu.fullscreen", "Toggle Fullscreen"),
      ),
      locked("desktop.quit", "desktop", ["mod+q"], (t) =>
        t("menu.quit", "Quit"),
      ),
    );
  }

  return commands;
}

/** The grid's name for each scope. */
export function scopeLabel(scope: ShortcutScope, t: TFunction): string {
  switch (scope) {
    case "general":
      return t("shortcuts.scope.general", "General");
    case "editor":
      return t("shortcuts.scope.editor", "Editor");
    case "calendar":
      return t("shortcuts.scope.calendar", "Calendar");
    case "desktop":
      return t("shortcuts.scope.desktop", "Desktop app");
  }
}
