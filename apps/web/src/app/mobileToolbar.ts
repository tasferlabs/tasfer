export type MobileToolbarBlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bullet_list"
  | "numbered_list"
  | "todo_list"
  | "image"
  | "line";

export type MobileToolbarIcon =
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "code"
  | "math_command"
  | "strikethrough"
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "list"
  | "list_ordered"
  | "list_todo"
  | "image"
  | "line"
  | "keyboard_dismiss";

export type MobileToolbarAction =
  | { type: "undo" }
  | { type: "redo" }
  | { type: "toggle-bold" }
  | { type: "toggle-italic" }
  | { type: "toggle-code" }
  | { type: "open-math-commands" }
  | { type: "toggle-strikethrough" }
  | { type: "set-block"; blockType: MobileToolbarBlockType }
  | { type: "dismiss" };

export type MobileToolbarItem =
  | {
      kind: "button";
      id: string;
      icon: MobileToolbarIcon;
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
      selected: MobileToolbarBlockType;
      options: Array<{
        id: MobileToolbarBlockType;
        icon: MobileToolbarIcon;
        label: string;
        action: MobileToolbarAction;
      }>;
    }
  | { kind: "divider"; id: string }
  | { kind: "spacer"; id: string };

/** The standard JSON/object input consumed by Android and iOS. */
export interface MobileToolbarModel {
  version: 1;
  visible: boolean;
  bottomInset: number;
  items: MobileToolbarItem[];
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
}

type Translate = (key: string, fallback?: string) => string;

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
  { type: "image", icon: "image", labelKey: "blocks.image" },
  { type: "line", icon: "line", labelKey: "blocks.divider" },
];

/**
 * Single source of truth for toolbar contents and order.
 *
 * Edit this function and both the Android React toolbar and the existing native
 * iOS accessory receive the resulting object.
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

  return {
    version: 1,
    visible: state.visible,
    bottomInset: state.bottomInset,
    items: [
      button("undo", "undo", t("editor.undo", "Undo"), { type: "undo" }, {
        enabled: state.canUndo,
      }),
      button("redo", "redo", t("editor.redo", "Redo"), { type: "redo" }, {
        enabled: state.canRedo,
      }),
      { kind: "divider", id: "history-divider" },
      button(
        "bold",
        "bold",
        t("editor.bold", "Bold"),
        { type: "toggle-bold" },
        { active: state.isBold },
      ),
      button(
        "italic",
        "italic",
        t("editor.italic", "Italic"),
        { type: "toggle-italic" },
        { active: state.isItalic },
      ),
      button(
        "code",
        "code",
        t("editor.code", "Code"),
        { type: "toggle-code" },
        { active: state.isCode },
      ),
      button(
        "math-command",
        "math_command",
        t("editor.math.chooseConstruct", "Math commands"),
        { type: "open-math-commands" },
        { enabled: state.canOpenMathCommands },
      ),
      button(
        "strikethrough",
        "strikethrough",
        t("editor.strikethrough", "Strikethrough"),
        { type: "toggle-strikethrough" },
        { active: state.isStrikethrough },
      ),
      { kind: "divider", id: "format-divider" },
      {
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
      },
      { kind: "spacer", id: "flex-spacer" },
      { kind: "divider", id: "dismiss-divider" },
      button(
        "dismiss",
        "keyboard_dismiss",
        t("editor.dismissKeyboard", "Dismiss keyboard"),
        { type: "dismiss" },
      ),
    ],
  };
}

export function isMobileToolbarBlockType(
  value: string,
): value is MobileToolbarBlockType {
  return BLOCKS.some((block) => block.type === value);
}
