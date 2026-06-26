import { filterMathCommands } from "@cypherkit/editor";
import { CODE_LANGUAGES } from "@cypherkit/editor/internal";

export type MobileToolbarBlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bullet_list"
  | "numbered_list"
  | "todo_list"
  | "quote"
  | "code"
  | "math"
  | "image"
  | "line";

export type MobileToolbarIcon =
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "code"
  | "math_command"
  | "math"
  | "strikethrough"
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "quote"
  | "list"
  | "list_ordered"
  | "list_todo"
  | "image"
  | "line"
  | "keyboard_dismiss"
  // Contextual controls (list/code/overflow). The native iOS accessory renders
  // these too — its bar is now built from the same contextual model — so they
  // need curated artwork. The icon generator (`scripts/gen-mobile-toolbar-icons.mjs`)
  // treats this union as the set of icons it must have an SVG for, so adding one
  // here requires a matching `apps/ios/icons/<name>.svg`.
  | "indent"
  | "outdent"
  | "todo_check"
  | "more";

export type MobileToolbarAction =
  | { type: "undo" }
  | { type: "redo" }
  | { type: "toggle-bold" }
  | { type: "toggle-italic" }
  | { type: "toggle-code" }
  | { type: "open-math-commands" }
  | { type: "insert-math-command"; latex: string }
  | { type: "toggle-strikethrough" }
  | { type: "set-block"; blockType: MobileToolbarBlockType }
  | { type: "indent-list" }
  | { type: "outdent-list" }
  | { type: "toggle-todo" }
  | { type: "set-code-language"; language: string }
  | { type: "dismiss" };

/** One construct in the contextual math row. The `latex` is both inserted on tap
 *  and rendered as the chip's preview by the host. */
export interface MathToolbarChip {
  id: string;
  /** Catalog name, used for the accessibility label. */
  name: string;
  latex: string;
}

/**
 * The contextual math row shown while the caret is in math — a block equation or
 * strictly inside an inline chip. In the browse state (`query === null`) it lists
 * a curated set of common constructs; once a `\command` is being typed it mirrors
 * the `\` menu's ranked matches, so tapping a chip is the same action as picking
 * from that menu. Both states are driven by the engine's
 * {@link filterMathCommands} catalog — one source of truth shared with the
 * floating menu and the inline drawer.
 */
export interface MobileToolbarMathRow {
  /** The in-progress `\` query, or null while browsing (no `\` typed yet). */
  query: string | null;
  chips: MathToolbarChip[];
}

/** Caret-in-math context the host feeds in; null when the caret is not in math
 *  (neither a block equation nor inside an inline chip). `query` is the
 *  in-progress `\command` text, or null while browsing. */
export interface MobileToolbarMathContext {
  query: string | null;
}

export type MobileToolbarItem =
  | {
      kind: "button";
      id: string;
      /** Optional — drawer entries (e.g. code languages) can be label-only. */
      icon?: MobileToolbarIcon;
      label: string;
      enabled: boolean;
      active: boolean;
      action: MobileToolbarAction;
    }
  | {
      kind: "menu";
      id: string;
      icon: MobileToolbarIcon;
      label: string;
      selected: string;
      options: Array<{
        id: string;
        /** Optional — language options are label-only. */
        icon?: MobileToolbarIcon;
        label: string;
        action: MobileToolbarAction;
      }>;
    }
  | { kind: "divider"; id: string }
  | { kind: "spacer"; id: string };

/** Which editing context produced the contextual layout. */
export type MobileToolbarContextKind = "format" | "list" | "code" | "math";

/**
 * The three-tier layout the in-webview React bar (Android/web touch) renders:
 * pinned ends that never scroll, a scrollable contextual middle, and an overflow
 * drawer for the long tail. The middle swaps by cursor context — math chips
 * inside an equation, structural controls inside a list/code block, otherwise
 * the formatting controls. The native iOS accessory ignores this and renders the
 * flat {@link MobileToolbarModel.items} instead.
 */
export interface MobileToolbarLayout {
  context: MobileToolbarContextKind;
  /** Pinned, non-scrolling left cluster (history + format primaries in prose). */
  left: MobileToolbarItem[];
  /** Scrollable contextual middle. */
  middle:
    | { kind: "items"; items: MobileToolbarItem[] }
    | ({ kind: "math" } & MobileToolbarMathRow);
  /** Overflow-drawer contents; when empty the "more" button is hidden. */
  more: MobileToolbarItem[];
  /** Pinned, non-scrolling right cluster (dismiss). */
  right: MobileToolbarItem[];
}

/**
 * Asset-catalog name for a math construct id. Lowercase letters/digits pass
 * through; everything else (uppercase letters, `^`, `_`) is escaped as `-<hex>`
 * — injective and safe on a case-insensitive filesystem (`Pi` vs `pi`). The
 * native bar looks chip images up by this name.
 *
 * MUST stay byte-identical to the copy in
 * packages/tex/scripts/gen-math-chip-icons.mjs.
 */
export function mathChipAssetName(id: string): string {
  let out = "math_";
  for (const ch of id) {
    out += /[a-z0-9]/.test(ch) ? ch : "-" + ch.codePointAt(0)!.toString(16);
  }
  return out;
}

/** A math chip projected for the native iOS accessory: the pre-rendered asset
 *  name, the LaTeX to insert, and the catalog name for the a11y label. */
export interface NativeMathChip {
  asset: string;
  latex: string;
  name: string;
}

/** The math row the native accessory renders — it can't draw the web bar's live
 *  SVG chips, so it shows the pre-rendered glyph assets instead. `query` is the
 *  in-progress `\command` (null while browsing); `noMatchLabel` is the localized
 *  empty state. */
export interface NativeMathRow {
  query: string | null;
  chips: NativeMathChip[];
  noMatchLabel: string;
}

/** What the host posts to the native iOS bridge: the shared model minus the
 *  webview-only `layout`, plus a compact math row when the caret is in math. */
export type NativeMobileToolbarModel = Omit<MobileToolbarModel, "layout"> & {
  mathRow?: NativeMathRow;
};

/** The standard JSON/object input consumed by Android and iOS. */
export interface MobileToolbarModel {
  version: 1;
  visible: boolean;
  bottomInset: number;
  /** Flat ordered toolbar consumed by the native iOS accessory. */
  items: MobileToolbarItem[];
  /**
   * Contextual three-tier layout for the in-webview React bar (Android/web). The
   * native iOS accessory has its own chrome and ignores it; the host strips it
   * before posting to the native bridge.
   */
  layout: MobileToolbarLayout;
}

interface MobileToolbarState {
  visible: boolean;
  bottomInset: number;
  canUndo: boolean;
  canRedo: boolean;
  isBold: boolean;
  isItalic: boolean;
  isCode: boolean;
  canOpenMathCommands: boolean;
  isStrikethrough: boolean;
  blockType: MobileToolbarBlockType;
  /** Indent depth of the current list item (0 when not in a list). */
  listIndent: number;
  /** Checked state of the current todo item (false when not a todo). */
  todoChecked: boolean;
  /** Language of the current code block ("" when not in code / untagged). */
  codeLanguage: string;
  math: MobileToolbarMathContext | null;
}

type Translate = (key: string, fallback?: string) => string;

// Every convertible block the schema registers, in rough descending order of how
// often it's reached (text → headings → lists → quote → code/math → media). The
// in-webview menu renders this top-to-bottom; the native iOS menu re-reverses it
// to match (it opens upward from the keyboard accessory — see
// NoAccessoryWebView.swift), so both shells read the same way. Mirrors the slash
// menu's catalog.
const BLOCKS: ReadonlyArray<{
  type: MobileToolbarBlockType;
  icon: MobileToolbarIcon;
  labelKey: string;
}> = [
  { type: "paragraph", icon: "paragraph", labelKey: "common.text" },
  { type: "heading1", icon: "heading1", labelKey: "blocks.heading1" },
  { type: "heading2", icon: "heading2", labelKey: "blocks.heading2" },
  { type: "heading3", icon: "heading3", labelKey: "blocks.heading3" },
  { type: "bullet_list", icon: "list", labelKey: "blocks.bulletList" },
  {
    type: "numbered_list",
    icon: "list_ordered",
    labelKey: "blocks.numberedList",
  },
  { type: "todo_list", icon: "list_todo", labelKey: "blocks.todoList" },
  { type: "quote", icon: "quote", labelKey: "blocks.quote" },
  { type: "code", icon: "code", labelKey: "blocks.code" },
  { type: "math", icon: "math", labelKey: "blocks.math" },
  { type: "image", icon: "image", labelKey: "blocks.image" },
  { type: "line", icon: "line", labelKey: "blocks.divider" },
];

const LIST_BLOCK_TYPES: readonly MobileToolbarBlockType[] = [
  "bullet_list",
  "numbered_list",
  "todo_list",
];

/** Deepest indent a list item can reach; mirrors `indentListItem`'s clamp. */
const MAX_LIST_INDENT = 6;

/**
 * Curated default constructs for the browse state, by catalog id, in display
 * order. Picked for thumb-frequency (fractions, scripts, big operators, the
 * common relations and Greek letters); the full catalog stays one `\` away.
 */
const DEFAULT_MATH_CHIP_IDS: readonly string[] = [
  "frac",
  "sqrt",
  "^",
  "_",
  "sum",
  "int",
  "lim",
  "infty",
  "leq",
  "geq",
  "neq",
  "times",
  "cdot",
  "pm",
  "to",
  "partial",
  "alpha",
  "beta",
  "theta",
  "pi",
  "lambda",
  "sigma",
];

const toChip = (cmd: {
  id: string;
  name: string;
  latex: string;
}): MathToolbarChip => ({ id: cmd.id, name: cmd.name, latex: cmd.latex });

/** Build the math row for a caret-in-math context (or null when not in math). */
export function buildMathRow(
  math: MobileToolbarMathContext | null,
): MobileToolbarMathRow | null {
  if (!math) return null;
  if (math.query === null) {
    const byId = new Map(filterMathCommands("").map((c) => [c.id, c]));
    const chips = DEFAULT_MATH_CHIP_IDS.flatMap((id) => {
      const cmd = byId.get(id);
      return cmd ? [toChip(cmd)] : [];
    });
    return { query: null, chips };
  }
  // Live: mirror the `\` menu's ranked matches, capped to keep the row light.
  const chips = filterMathCommands(math.query).slice(0, 24).map(toChip);
  return { query: math.query, chips };
}

/**
 * The active `\command` being typed in math text (a block equation, or the LaTeX
 * of an inline chip — both live in the block's text), or null. Mirrors the
 * floating menu's detection: the nearest `\` before the caret followed only by
 * letters (a space/brace/digit ends a command name). An empty query (the `\`
 * just typed) still counts as active — it surfaces the full ranked list.
 */
export function activeBlockMathCommand(
  text: string,
  caretOffset: number,
): { backslashIndex: number; query: string } | null {
  const backslashIndex = text.lastIndexOf("\\", caretOffset - 1);
  if (backslashIndex < 0) return null;
  const query = text.slice(backslashIndex + 1, caretOffset);
  if (!/^[a-zA-Z]*$/.test(query)) return null;
  return { backslashIndex, query };
}

/**
 * Single source of truth for toolbar contents and order.
 *
 * Produces both the flat `items` list (rendered by the native iOS accessory)
 * and the contextual `layout` (rendered by the in-webview Android/web bar). Edit
 * this function and every platform receives the resulting object.
 */
export function createMobileToolbarModel(
  state: MobileToolbarState,
  t: Translate,
): MobileToolbarModel {
  const button = (
    id: string,
    icon: MobileToolbarIcon,
    label: string,
    action: MobileToolbarAction,
    options: { enabled?: boolean; active?: boolean } = {},
  ): MobileToolbarItem => ({
    kind: "button",
    id,
    icon,
    label,
    action,
    enabled: options.enabled ?? true,
    active: options.active ?? false,
  });

  const divider = (id: string): MobileToolbarItem => ({ kind: "divider", id });

  const undo = button(
    "undo",
    "undo",
    t("editor.undo", "Undo"),
    {
      type: "undo",
    },
    { enabled: state.canUndo },
  );
  const redo = button(
    "redo",
    "redo",
    t("editor.redo", "Redo"),
    {
      type: "redo",
    },
    { enabled: state.canRedo },
  );
  const bold = button(
    "bold",
    "bold",
    t("editor.bold", "Bold"),
    { type: "toggle-bold" },
    { active: state.isBold },
  );
  const italic = button(
    "italic",
    "italic",
    t("editor.italic", "Italic"),
    { type: "toggle-italic" },
    { active: state.isItalic },
  );
  const inlineCode = button(
    "code",
    "code",
    t("editor.code", "Code"),
    { type: "toggle-code" },
    { active: state.isCode },
  );
  const strikethrough = button(
    "strikethrough",
    "strikethrough",
    t("editor.strikethrough", "Strikethrough"),
    { type: "toggle-strikethrough" },
    { active: state.isStrikethrough },
  );
  const mathCommand = button(
    "math-command",
    "math_command",
    t("editor.math.chooseConstruct", "Math commands"),
    { type: "open-math-commands" },
    { enabled: state.canOpenMathCommands },
  );
  const dismiss = button(
    "dismiss",
    "keyboard_dismiss",
    t("editor.dismissKeyboard", "Dismiss keyboard"),
    { type: "dismiss" },
  );

  const blockMenu: MobileToolbarItem = {
    kind: "menu",
    id: "block",
    icon:
      BLOCKS.find((block) => block.type === state.blockType)?.icon ??
      "paragraph",
    label: t("editor.blockType", "Block type"),
    selected: state.blockType,
    options: BLOCKS.map((block) => ({
      id: block.type,
      icon: block.icon,
      label: t(block.labelKey),
      action: { type: "set-block", blockType: block.type },
    })),
  };

  const layout = buildLayout(state, t, {
    undo,
    redo,
    bold,
    italic,
    inlineCode,
    strikethrough,
    blockMenu,
    dismiss,
  });

  return {
    version: 1,
    visible: state.visible,
    bottomInset: state.bottomInset,
    // The native iOS accessory renders a flat bar; project the same contextual
    // layout into one so both shells share a single source of truth.
    items: flattenLayoutForNative(layout, mathCommand, divider, t),
    layout,
  };
}

/**
 * Project the contextual {@link MobileToolbarLayout} into the flat ordered list
 * the native iOS accessory renders. The native shell can't draw the live math
 * chip row, so a caret-in-math context collapses to the math-command button
 * (which opens the floating `\` menu); the overflow drawer becomes a single
 * "more" menu (a native popup); and the trailing cluster ("more" + dismiss) is
 * pinned via the `dismiss-divider` the accessory keys on to split scroll/fixed.
 */
function flattenLayoutForNative(
  layout: MobileToolbarLayout,
  mathCommand: MobileToolbarItem,
  divider: (id: string) => MobileToolbarItem,
  t: Translate,
): MobileToolbarItem[] {
  const middle =
    layout.middle.kind === "math" ? [mathCommand] : layout.middle.items;

  const trailing: MobileToolbarItem[] = [];
  if (layout.more.length > 0) {
    // The native popup marks one option as checked; surface the active control
    // (the current language, or an enabled mark) so selection stays visible.
    const active = layout.more.find(
      (item) => item.kind === "button" && item.active,
    );
    trailing.push({
      kind: "menu",
      id: "more",
      icon: "more",
      label: t("editor.more", "More"),
      selected: active?.id ?? "",
      options: layout.more.flatMap((item) =>
        item.kind === "button"
          ? [
              {
                id: item.id,
                icon: item.icon,
                label: item.label,
                action: item.action,
              },
            ]
          : [],
      ),
    });
  }

  return [
    ...layout.left,
    divider("zone-divider"),
    ...middle,
    divider("dismiss-divider"),
    ...trailing,
    ...layout.right,
  ];
}

/** Build the contextual three-tier layout for the in-webview bar. */
function buildLayout(
  state: MobileToolbarState,
  t: Translate,
  controls: {
    undo: MobileToolbarItem;
    redo: MobileToolbarItem;
    bold: MobileToolbarItem;
    italic: MobileToolbarItem;
    inlineCode: MobileToolbarItem;
    strikethrough: MobileToolbarItem;
    blockMenu: MobileToolbarItem;
    dismiss: MobileToolbarItem;
  },
): MobileToolbarLayout {
  const { undo, redo, bold, italic, inlineCode, strikethrough, blockMenu } =
    controls;
  const right = [controls.dismiss];

  // Math owns the whole middle: structural blocks can't nest in an equation, so
  // there are no list/code controls to compete with the chip row.
  if (state.math) {
    const mathRow = buildMathRow(state.math)!;
    return {
      context: "math",
      left: [undo, redo],
      middle: { kind: "math", ...mathRow },
      more: [],
      right,
    };
  }

  if (state.blockType === "code") {
    return {
      context: "code",
      left: [undo, redo],
      middle: { kind: "items", items: [blockMenu] },
      // Code carries no inline marks; the drawer instead holds the language
      // list (the only code-specific control), shown as a selectable set.
      more: codeLanguageItems(state),
      right,
    };
  }

  if (LIST_BLOCK_TYPES.includes(state.blockType)) {
    const outdent = {
      kind: "button" as const,
      id: "outdent",
      icon: "outdent" as const,
      label: t("editor.outdent", "Outdent"),
      action: { type: "outdent-list" as const },
      enabled: true,
      active: false,
    };
    const indent = {
      kind: "button" as const,
      id: "indent",
      icon: "indent" as const,
      label: t("editor.indent", "Indent"),
      action: { type: "indent-list" as const },
      enabled: state.listIndent < MAX_LIST_INDENT,
      active: false,
    };
    const middleItems: MobileToolbarItem[] = [blockMenu, outdent, indent];
    if (state.blockType === "todo_list") {
      middleItems.push({
        kind: "button",
        id: "todo-toggle",
        icon: "todo_check",
        label: state.todoChecked
          ? t("editor.markNotDone", "Mark not done")
          : t("editor.markDone", "Mark done"),
        action: { type: "toggle-todo" },
        enabled: true,
        active: state.todoChecked,
      });
    }
    return {
      context: "list",
      left: [undo, redo],
      middle: { kind: "items", items: middleItems },
      // The structural controls take the middle; marks move to the drawer.
      more: [bold, italic, strikethrough, inlineCode],
      right,
    };
  }

  // Format (prose): pin the high-frequency marks; block type stays in reach in
  // the middle; the rarer marks live in the drawer.
  return {
    context: "format",
    left: [undo, redo, controlsDivider(), bold, italic],
    middle: { kind: "items", items: [blockMenu] },
    more: [strikethrough, inlineCode],
    right,
  };
}

function controlsDivider(): MobileToolbarItem {
  return { kind: "divider", id: "history-divider" };
}

/** The code-block language list, as selectable (label-only) drawer cells. */
function codeLanguageItems(state: MobileToolbarState): MobileToolbarItem[] {
  return CODE_LANGUAGES.map((lang) => ({
    kind: "button",
    id: `language-${lang.id}`,
    label: lang.label,
    action: { type: "set-code-language", language: lang.id },
    enabled: true,
    active: lang.id === state.codeLanguage,
  }));
}

export function isMobileToolbarBlockType(
  value: string,
): value is MobileToolbarBlockType {
  return BLOCKS.some((block) => block.type === value);
}
