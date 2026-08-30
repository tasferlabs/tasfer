import type { TableAlign, TableInsertSide } from "@tasfer/table";
import {
  mathElementLabel,
  mathMenuMode,
  type MathMenuTrigger,
  searchMathCommands,
} from "../editor/mathCommandSearch";

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
  // Inserting a table from the block switcher. The caret is never *in* a table
  // when the switcher is shown — a cell's own menu takes that slot (see
  // `buildLayout`) — so this entry only ever converts prose into a fresh grid,
  // the way the desktop slash menu's "Table" does.
  | "table"
  | "line";

export type MobileToolbarIcon =
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "code"
  | "mathcommand"
  | "math"
  | "strikethrough"
  | "text"
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "quote"
  | "list"
  | "list_ordered"
  | "list_todo"
  | "image"
  // Enter an image's reposition mode. Touch has no hover, so the on-canvas
  // affordance never appears there — this and the long-press context menu are
  // the way in.
  | "reposition"
  | "link"
  | "line"
  | "keyboard_dismiss"
  // Contextual controls (list/code/overflow). The native iOS accessory renders
  // these too — its bar is now built from the same contextual model — so they
  // need native artwork. The icon generator (`scripts/gen-mobile-toolbar-icons.mjs`)
  // treats this union as the set of icons it must emit, deriving each from Lucide
  // (the same source the web bar uses), so adding one here requires a matching
  // entry in that script's LUCIDE/CUSTOM_BODY map.
  | "indent"
  | "outdent"
  | "todo_check"
  | "more"
  // The matrix editor trigger — a 3×3 grid glyph. Shown when the caret sits in a
  // tabular construct; opens the row/column editor (dialog on desktop, drawer on
  // touch).
  | "matrix"
  // The table menu's trigger. Shown when the caret sits in a table cell; its
  // options are the structural commands below. Touch has no right-click, so this
  // menu is the ONLY way to reach a table's structural commands on a phone.
  | "table"
  // The table menu's own glyphs: insert a row above/below or a column
  // before/after the caret's cell, drop the row/column it is in (`trash`), and
  // set the column's alignment. Same Lucide art the desktop table menu draws.
  | "row_above"
  | "row_below"
  | "column_before"
  | "column_after"
  | "trash"
  | "align_default"
  | "align_left"
  | "align_center"
  | "align_right"
  | "caret_left"
  | "caret_right"
  // The code block's language-picker trigger. Distinct from `code` (the inline
  // mark / block-type glyph) so it doesn't read as a duplicate beside the block
  // switcher in the code toolbar.
  | "code_language";

export type MobileToolbarAction =
  | { type: "undo" }
  | { type: "redo" }
  | { type: "toggle-bold" }
  | { type: "toggle-italic" }
  | { type: "toggle-code" }
  | { type: "toggle-math" }
  | { type: "open-math-commands" }
  | { type: "insert-math-command"; latex: string }
  // Step the caret one position left/right. In math these snap over whole
  // constructs and out to a construct's edge (the caret model's `charLeft`/
  // `charRight`), so they are how you exit a `\dot`, a script slot, a fraction —
  // a mobile keyboard offers no arrow keys of its own.
  | { type: "caret-left" }
  | { type: "caret-right" }
  // Open the matrix editor (grid preview + row/column steppers) for the grid the
  // caret sits in. The host renders it as a dialog on desktop and a drawer on
  // touch — the same surface the desktop context menu's "Edit matrix" opens.
  | { type: "open-matrix-editor" }
  // The table's structural commands, every one relative to the cell the caret is
  // in — the same commands the desktop table menu dispatches. They ride the
  // toolbar's table menu rather than a surface of their own: a phone has no
  // right-click and no room beside the grid for a floating bar.
  | { type: "table-insert-row"; side: TableInsertSide }
  | { type: "table-delete-row" }
  | { type: "table-insert-column"; side: TableInsertSide }
  | { type: "table-delete-column" }
  | { type: "table-align"; align: TableAlign | null }
  | { type: "toggle-strikethrough" }
  | { type: "set-block"; blockType: MobileToolbarBlockType }
  | { type: "indent-list" }
  | { type: "outdent-list" }
  // Reindent the caret's line(s) in a code block by one level. The code
  // counterpart to the list indent/outdent controls — a soft keyboard has no
  // Tab / Shift+Tab.
  | { type: "indent-code" }
  | { type: "outdent-code" }
  | { type: "toggle-todo" }
  | { type: "edit-link" }
  | { type: "edit-image" }
  // Put the selected image into reposition mode, where a drag over it pans the
  // crop. Only the way IN lives here: once the mode is on, the engine pins its
  // own Done/Cancel chrome to the image (it no longer gates that on hover), and
  // those belong beside the crop the user is dragging, not at the screen edge.
  | { type: "reposition-image" }
  // Open the code block's language picker as a drawer/sheet (the host renders it
  // as a bottom sheet on mobile). Replaces the flat language list that used to
  // live behind the overflow "more" button.
  | { type: "edit-code" }
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
 * strictly inside an inline chip. It carries chips only while a command is being
 * typed (`query !== null`); the chips mirror the desktop menu's matches for the
 * same trigger, so tapping one is the same action as picking from that menu.
 * Both surfaces rank through {@link searchMathCommands} — one source of truth.
 */
export interface MobileToolbarMathRow {
  /** The in-progress query, or null while browsing (no trigger typed yet). */
  query: string | null;
  /** Which trigger opened the run: `/` searches element names, `\` LaTeX. */
  trigger: MathMenuTrigger | null;
  chips: MathToolbarChip[];
}

/** Caret-in-math context the host feeds in; null when the caret is not in math
 *  (neither a block equation nor inside an inline chip). `query` is the
 *  in-progress command text and `trigger` the character that opened it, or both
 *  null while browsing. `canCaretLeft`/`canCaretRight` are false when the caret
 *  sits on the formula's left/right edge — the step in that direction would
 *  leave the math, so the toolbar's caret control is disabled rather than
 *  silently exiting the equation. */
export interface MobileToolbarMathContext {
  query: string | null;
  trigger: MathMenuTrigger | null;
  canCaretLeft: boolean;
  canCaretRight: boolean;
  /** The grid construct the caret sits in (matrix/cases/aligned/array), or null.
   *  When set, the toolbar shows a matrix control that opens the row/column
   *  editor, seeded with these dimensions. */
  matrix: MobileToolbarMatrixContext | null;
}

/**
 * The table the caret rests in, as much of it as the toolbar's menu needs: how
 * big the grid is (a table's last row and last column cannot be deleted, so
 * those commands are left out rather than offered and refused) and how the
 * caret's column is aligned, which the menu check-marks.
 */
export interface MobileToolbarTableContext {
  rows: number;
  columns: number;
  align: TableAlign | null;
}

/** The grid the caret rests in — its environment, dimensions, and the caret's
 *  cell. Seeds the matrix editor's initial row/column counts. */
export interface MobileToolbarMatrixContext {
  env: string;
  rows: number;
  cols: number;
  row: number;
  col: number;
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
      /** Highlight the trigger (primary tint) — e.g. an overflow menu whose
       *  hidden controls include an active one. */
      active?: boolean;
      /**
       * Keep the options panel up after a pick, instead of closing it the way a
       * one-shot choice (block type, code language) does. For the table's
       * commands, which come in runs — three rows, then align the column — and
       * whose options are rebuilt from the grid's live shape after every edit.
       *
       * In-webview only: the native iOS accessory renders menus as a `UIMenu`,
       * which always dismisses on selection.
       */
      sticky?: boolean;
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
export type MobileToolbarContextKind =
  "format" | "list" | "code" | "math" | "image";

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
  isMath: boolean;
  canOpenMathCommands: boolean;
  /**
   * The grid the caret sits in, or null when it is not in a table. Touch has no
   * right-click, so the toolbar's table menu is the only way to reach a table's
   * structural commands on a phone — this is what puts it there, and its shape
   * is what decides which of them the menu can offer.
   */
  table: MobileToolbarTableContext | null;
  isStrikethrough: boolean;
  blockType: MobileToolbarBlockType;
  /** Indent depth of the current list item (0 when not in a list). */
  listIndent: number;
  /** Checked state of the current todo item (false when not a todo). */
  todoChecked: boolean;
  /** Whether the caret/selection rests on an existing link mark. */
  linkActive: boolean;
  /** Whether a non-empty text selection exists that a new link could wrap. */
  canCreateLink: boolean;
  /**
   * Whether the selected image has crop slack to move at its drawn size. False
   * off an image block, and for a cover whose aspect already matches its frame
   * — offering a reposition that cannot move anything would be a lie.
   */
  canRepositionImage: boolean;
  /** Whether the selected image is already in reposition mode. */
  repositioningImage: boolean;
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
  { type: "paragraph", icon: "text", labelKey: "common.text" },
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
  { type: "table", icon: "table", labelKey: "blocks.table" },
  { type: "line", icon: "line", labelKey: "blocks.divider" },
];

const LIST_BLOCK_TYPES: readonly MobileToolbarBlockType[] = [
  "bullet_list",
  "numbered_list",
  "todo_list",
];

/** Deepest indent a list item can reach; mirrors `indentListItem`'s clamp. */
const MAX_LIST_INDENT = 6;

/** One entry in a toolbar menu's options panel. */
type MenuOption = Extract<
  MobileToolbarItem,
  { kind: "menu" }
>["options"][number];

/**
 * The table's command menu.
 *
 * The same commands, in the same order, as the desktop table menu — a table is
 * edited with one vocabulary whichever shell you reach it from. Every one is
 * relative to the caret's cell, so the menu carries no target of its own.
 *
 * A command that cannot run is left out rather than offered and refused: the
 * only two are the deletes, and a table's last row and last column have nothing
 * to fall back to. `selected` names the caret column's alignment — the native
 * accessory check-marks that option, the in-webview panel highlights its cell.
 */
function buildTableMenu(
  table: MobileToolbarTableContext,
  t: Translate,
): MobileToolbarItem {
  const rows: MenuOption[] = [
    {
      id: "row-above",
      icon: "row_above",
      label: t("editor.table.addRowAbove", "Add row above"),
      action: { type: "table-insert-row", side: "before" },
    },
    {
      id: "row-below",
      icon: "row_below",
      label: t("editor.table.addRowBelow", "Add row below"),
      action: { type: "table-insert-row", side: "after" },
    },
  ];
  if (table.rows > 1) {
    rows.push({
      id: "row-delete",
      icon: "trash",
      label: t("editor.table.removeRow", "Remove row"),
      action: { type: "table-delete-row" },
    });
  }

  const columns: MenuOption[] = [
    {
      id: "column-before",
      icon: "column_before",
      label: t("editor.table.addColumnBefore", "Add column before"),
      action: { type: "table-insert-column", side: "before" },
    },
    {
      id: "column-after",
      icon: "column_after",
      label: t("editor.table.addColumnAfter", "Add column after"),
      action: { type: "table-insert-column", side: "after" },
    },
  ];
  if (table.columns > 1) {
    columns.push({
      id: "column-delete",
      icon: "trash",
      label: t("editor.table.removeColumn", "Remove column"),
      action: { type: "table-delete-column" },
    });
  }

  const alignment: MenuOption[] = [
    {
      id: "align-default",
      icon: "align_default",
      label: t("editor.table.alignDefault", "Default alignment"),
      action: { type: "table-align", align: null },
    },
    {
      id: "align-left",
      icon: "align_left",
      label: t("editor.table.alignLeft", "Align left"),
      action: { type: "table-align", align: "left" },
    },
    {
      id: "align-center",
      icon: "align_center",
      label: t("editor.table.alignCenter", "Align center"),
      action: { type: "table-align", align: "center" },
    },
    {
      id: "align-right",
      icon: "align_right",
      label: t("editor.table.alignRight", "Align right"),
      action: { type: "table-align", align: "right" },
    },
  ];

  return {
    kind: "menu",
    id: "table",
    icon: "table",
    label: t("editor.table.title", "Edit table"),
    selected: `align-${table.align ?? "default"}`,
    sticky: true,
    options: [...rows, ...columns, ...alignment],
  };
}

/**
 * Build the math row for a caret-in-math context (or null when not in math).
 * Construct suggestions surface ONLY while a command is being typed (`query
 * !== null`): the toolbar is narrow, and a permanent browse row of chips crowds
 * out the caret controls that let you step out of a construct (a mobile keyboard
 * has no arrow keys). While just editing (`query === null`) the row is empty —
 * tap the `/` trigger to start a command.
 */
export function buildMathRow(
  math: MobileToolbarMathContext | null,
  t: Translate,
): MobileToolbarMathRow | null {
  if (!math) return null;
  if (math.query === null) return { query: null, trigger: null, chips: [] };
  const trigger = math.trigger ?? "/";
  const label = (key: string, fallback: string) => t(key, fallback);
  // Live: mirror the menu's ranked matches, capped to keep the row light. The
  // chip name is the a11y label, so it follows the UI language.
  const chips = searchMathCommands(math.query, mathMenuMode(trigger), label)
    .slice(0, 24)
    .map((cmd) => ({
      id: cmd.id,
      name: mathElementLabel(cmd, label),
      latex: cmd.latex,
    }));
  return { query: math.query, trigger, chips };
}

/**
 * The active command being typed in FLAT math text (an inline chip whose LaTeX
 * lives literally in the block's text), or null. Tree-backed math reads the run
 * from the raw-text field instead (`activeTreeMathCommandRun`) — its projected
 * source is not a faithful echo of what was typed. Detection: the nearest `/`
 * or `\` before the caret followed only by query letters (a space/brace/digit
 * ends a command name; `\` takes ASCII letters, `/` any script since it
 * searches localized element names). An empty query (the trigger just typed)
 * still counts as active — it surfaces the full ranked list.
 */
export function activeBlockMathCommand(
  text: string,
  caretOffset: number,
): { triggerIndex: number; trigger: MathMenuTrigger; query: string } | null {
  if (caretOffset <= 0) return null;
  const backslash = text.lastIndexOf("\\", caretOffset - 1);
  const slash = text.lastIndexOf("/", caretOffset - 1);
  const triggerIndex = Math.max(backslash, slash);
  if (triggerIndex < 0) return null;
  const trigger: MathMenuTrigger = triggerIndex === slash ? "/" : "\\";
  const query = text.slice(triggerIndex + 1, caretOffset);
  const validQuery = trigger === "/" ? /^\p{L}*$/u : /^[a-zA-Z]*$/;
  if (!validQuery.test(query)) return null;
  return { triggerIndex, trigger, query };
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
  const inlineMath = button(
    "inline-math",
    "math",
    t("editor.math.inline", "Inline math"),
    { type: "toggle-math" },
    { active: state.isMath },
  );
  // The native iOS accessory replaces the item with id "math-command" with the
  // live chip row (see NoAccessoryWebView.swift), so `mathCommand` is only the
  // chip-row anchor there — it is never rendered as a button. The visible,
  // tappable `/` trigger is `mathTrigger`, which carries a distinct id so it
  // renders as a real button on every shell while sitting beside the chips.
  const mathCommand = button(
    "math-command",
    "mathcommand",
    t("editor.math.chooseConstruct", "Choose a math element"),
    { type: "open-math-commands" },
    { enabled: state.canOpenMathCommands },
  );
  const mathTrigger = button(
    "math-trigger",
    "mathcommand",
    t("editor.math.chooseConstruct", "Choose a math element"),
    { type: "open-math-commands" },
    { enabled: state.canOpenMathCommands },
  );
  // The matrix control — a grid glyph that opens the consolidated row/column
  // editor (a dialog on desktop, a drawer on touch). A single button, not a menu
  // of ops: the host surface owns the whole grid-resize interaction. It lives in
  // the overflow drawer (see `buildLayout`'s math branch), shown only when the
  // caret sits in a grid construct (`state.math.matrix`).
  const matrixButton = button(
    "matrix-editor",
    "matrix",
    t("editor.math.matrix.menu", "Edit matrix"),
    { type: "open-matrix-editor" },
  );
  // The table control — the same command set the desktop table menu carries,
  // hung off the toolbar as a menu of its own. The commands are relative to the
  // caret's cell, so they belong wherever the caret is being typed; on a phone
  // that is this bar, not a floating strip the soft keyboard would cover.
  //
  // Sticky: adding three rows should not mean opening the menu three times. Its
  // options are rebuilt from the grid's live shape, so the panel keeps up.
  const tableMenu = state.table ? buildTableMenu(state.table, t) : null;
  const dismiss = button(
    "dismiss",
    "keyboard_dismiss",
    t("editor.dismissKeyboard", "Dismiss keyboard"),
    { type: "dismiss" },
  );
  // Contextual settings buttons. The link control lives in the overflow drawer
  // ("extra"): it edits the link under the caret/selection when one exists, and
  // otherwise turns the current text selection into a new link. It is enabled in
  // either of those cases and greyed out when neither applies (empty caret, no
  // link). The image control is the whole bar when an image block is selected
  // and opens the image settings drawer. Both live in the shared model so every
  // shell — the in-webview Android/web bar and the native iOS accessory —
  // renders the same entry point.
  const link = button(
    "edit-link",
    "link",
    t("editor.link.link", "Link"),
    { type: "edit-link" },
    {
      active: state.linkActive,
      enabled: state.linkActive || state.canCreateLink,
    },
  );
  const editImage = button(
    "edit-image",
    "image",
    t("editor.image.editImage", "Edit Image"),
    { type: "edit-image" },
  );
  // Disabled rather than hidden once the mode is on: re-entering would re-stamp
  // the origin Cancel restores to, quietly making the pan so far permanent. The
  // active state says the mode is running; Done/Cancel are on the image.
  const repositionImage = button(
    "reposition-image",
    "reposition",
    t("image.reposition", "Reposition"),
    { type: "reposition-image" },
    {
      active: state.repositioningImage,
      enabled: state.canRepositionImage && !state.repositioningImage,
    },
  );
  // Opens the code block's language picker drawer/sheet. Sits in the code
  // context's contextual middle beside the block switcher; it replaces the flat
  // language list that used to hide behind the overflow "more" button.
  const editCode = button(
    "edit-code",
    "code_language",
    t("code.selectLanguage", "Select language"),
    { type: "edit-code" },
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
    inlineMath,
    mathTrigger,
    matrixButton,
    tableMenu,
    blockMenu,
    dismiss,
    link,
    editImage,
    repositionImage,
    editCode,
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
 * chip row, so a caret-in-math context emits the `mathCommand` anchor (id
 * "math-command") whose slot the accessory replaces with the chip glyphs; the
 * visible `/` trigger lives separately in `layout.left`. The overflow drawer
 * becomes a single "more" menu (a native popup); and the trailing cluster
 * ("more" + dismiss) is pinned via the `fixed-row-start` marker the accessory
 * keys on to split scroll/fixed.
 */
function flattenLayoutForNative(
  layout: MobileToolbarLayout,
  mathCommand: MobileToolbarItem,
  divider: (id: string) => MobileToolbarItem,
  t: Translate,
): MobileToolbarItem[] {
  // The math middle is the live chip row, anchored by the `mathCommand` slot the
  // accessory fills. It's present only while a command is being typed (`query
  // !== null`); when just editing, the row is empty, so emit nothing and let the
  // caret controls in `layout.left` carry the context (mirrors the in-webview
  // bar's empty browse state — see `buildMathRow`).
  const middle =
    layout.middle.kind === "math"
      ? layout.middle.query !== null
        ? [mathCommand]
        : []
      : layout.middle.items;

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
      // Light up the overflow trigger when a hidden control is active, mirroring
      // an active inline mark on the visible bar.
      active: !!active,
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
    // The separator sits to the right of the overflow button — between it and
    // the pinned dismiss control — matching the in-webview Android bar.
    trailing.push(divider("more-divider"));
  }

  return [
    ...layout.left,
    // The zone divider only earns its place when there is a scrollable middle to
    // fence off. In prose the middle is empty, so emitting it would leave a
    // dangling border at the end of the scroll row.
    ...(middle.length > 0 ? [divider("zone-divider"), ...middle] : []),
    // Invisible marker: everything from here on is pinned to the non-scrolling
    // fixed row (the overflow trigger and dismiss). The native shell keys on
    // this id to split the scrollable run from the pinned tail.
    { kind: "spacer", id: "fixed-row-start" },
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
    inlineMath: MobileToolbarItem;
    mathTrigger: MobileToolbarItem;
    matrixButton: MobileToolbarItem;
    /** The table menu, or null when the caret is not in a table. */
    tableMenu: MobileToolbarItem | null;
    blockMenu: MobileToolbarItem;
    dismiss: MobileToolbarItem;
    link: MobileToolbarItem;
    editImage: MobileToolbarItem;
    repositionImage: MobileToolbarItem;
    editCode: MobileToolbarItem;
  },
): MobileToolbarLayout {
  const {
    undo,
    redo,
    bold,
    italic,
    inlineCode,
    strikethrough,
    inlineMath,
    blockMenu,
    link,
    editImage,
    repositionImage,
    editCode,
  } = controls;
  const right = [controls.dismiss];

  // An image block has no inline text to format: its whole contextual bar is the
  // settings controls (reposition, replace/remove), shown beside history. This
  // is the caret-on-an-image case with the keyboard still up (the bar never
  // outlives the keyboard); with the keyboard closed the same two actions live
  // in the long-press context menu. Reposition appears only for a crop that can
  // actually move — its on-canvas twin is revealed by hover, which touch never
  // produces.
  if (state.blockType === "image") {
    return {
      context: "image",
      left: [undo, redo],
      middle: {
        kind: "items",
        items: state.canRepositionImage
          ? [repositionImage, editImage]
          : [editImage],
      },
      more: [],
      right,
    };
  }

  // Math owns the whole middle: structural blocks can't nest in an equation, so
  // there are no list/code controls to compete with the chip row.
  if (state.math) {
    const mathRow = buildMathRow(state.math, t)!;
    // Left/right caret steps, pinned beside the `/` trigger. In math they snap
    // over whole constructs and out to their edges, so they are the way to leave
    // a `\dot`/script slot/fraction — a mobile keyboard has no arrow keys. They
    // show ONLY while browsing (`query === null`): once a command is being
    // typed, the suggestion chips fill the middle, and the two clusters would
    // compete for the same scarce width — so the arrows step aside for them.
    const caretLeft: MobileToolbarItem = {
      kind: "button",
      id: "caret-left",
      icon: "caret_left",
      label: t("editor.math.moveCaretLeft", "Move left"),
      action: { type: "caret-left" },
      // Disabled on the formula's left edge: the step would exit the math, so
      // grey it out rather than silently leaving the equation.
      enabled: state.math.canCaretLeft,
      active: false,
    };
    const caretRight: MobileToolbarItem = {
      kind: "button",
      id: "caret-right",
      icon: "caret_right",
      label: t("editor.math.moveCaretRight", "Move right"),
      action: { type: "caret-right" },
      // Disabled on the formula's right edge (mirror of caret-left).
      enabled: state.math.canCaretRight,
      active: false,
    };
    const caretControls: MobileToolbarItem[] =
      mathRow.query === null ? [caretLeft, caretRight] : [];
    // The matrix editor trigger lives in the overflow drawer ("extra"), behind the
    // "more" control — not as a standalone bar button. It's a rarely-reached
    // structural edit, so it sits in the long tail like the drawer marks/link
    // elsewhere rather than taking permanent width beside the caret controls.
    // Present only when the caret sits in a grid (`state.math.matrix`).
    const more: MobileToolbarItem[] = state.math.matrix
      ? [controls.matrixButton]
      : [];
    // Pin the `/` trigger as the first contextual control (right after the
    // always-leading undo/redo): the math middle is the chip row, so without this
    // there's no quick way to start a command on a keyboard that hides `/` and
    // `\` behind a symbol page. It types a literal `/` (see
    // `open-math-commands`) and the chips then follow what you type after it. On
    // native the chip row is anchored separately via the `mathCommand` slot, so
    // both stay visible.
    return {
      context: "math",
      left: [
        undo,
        redo,
        controlsDivider(),
        controls.mathTrigger,
        ...caretControls,
      ],
      middle: { kind: "math", ...mathRow },
      more,
      right,
    };
  }

  if (state.blockType === "code") {
    // Indent/outdent the current line(s), mirroring the list controls — a soft
    // keyboard has no Tab / Shift+Tab. Both stay enabled: code nests without a
    // depth cap, and outdent is a harmless no-op on an already-flush line.
    const outdent: MobileToolbarItem = {
      kind: "button",
      id: "code-outdent",
      icon: "outdent",
      label: t("editor.outdent", "Outdent"),
      action: { type: "outdent-code" },
      enabled: true,
      active: false,
    };
    const indent: MobileToolbarItem = {
      kind: "button",
      id: "code-indent",
      icon: "indent",
      label: t("editor.indent", "Indent"),
      action: { type: "indent-code" },
      enabled: true,
      active: false,
    };
    return {
      context: "code",
      left: [undo, redo],
      // Code carries no inline marks. Its code-specific controls are the language
      // picker (a searchable drawer/sheet, so the whole catalog stays reachable
      // without a flat overflow list) and the indent/outdent pair.
      middle: { kind: "items", items: [blockMenu, editCode, outdent, indent] },
      more: [],
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
      // The structural controls take the middle; marks (and the link control)
      // move to the drawer.
      more: [bold, italic, strikethrough, inlineCode, inlineMath, link],
      right,
    };
  }

  // Format (prose): keep block type before inline marks; the rarer marks live
  // in the drawer. A divider sits after the block switcher to separate it from
  // the inline format controls — they are two different kinds of action.
  //
  // A table cell is prose, so this row is right there too — the caret can be
  // bold, linked and italic inside a cell like anywhere else. What it cannot be
  // is another block type: a table owns its content surface, so every entry in
  // the block switcher would be refused. The table's own control takes that
  // slot instead — the one structural affordance a table has on touch, in the
  // position the structural control already occupies.
  const inTableCell = controls.tableMenu != null;
  return {
    context: "format",
    left: [
      undo,
      redo,
      controlsDivider(),
      controls.tableMenu ?? blockMenu,
      blockDivider(),
      bold,
      italic,
    ],
    middle: { kind: "items", items: [] },
    // The link control lives in the overflow drawer ("extra") alongside the
    // rarer marks: it edits an existing link or creates one from the selection.
    //
    // Inline math is the one mark a cell is NOT offered. A math mark's content
    // lives in a separate attachment, and a cell has no route to one — the
    // toggle is refused in the engine (`toggleTableMark`), so the button would
    // be dead. Drop it rather than show a control that does nothing.
    more: inTableCell
      ? [strikethrough, inlineCode, link]
      : [strikethrough, inlineCode, inlineMath, link],
    right,
  };
}

function controlsDivider(): MobileToolbarItem {
  return { kind: "divider", id: "history-divider" };
}

/** Separates the block-type switcher from the inline format marks. */
function blockDivider(): MobileToolbarItem {
  return { kind: "divider", id: "block-divider" };
}

export function isMobileToolbarBlockType(
  value: string,
): value is MobileToolbarBlockType {
  return BLOCKS.some((block) => block.type === value);
}
