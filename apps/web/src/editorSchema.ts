import {
  CodeMark,
  type Editor,
  EmphasisMark,
  ImageNode,
  LineNode,
  LinkMark,
  ListNode,
  type MarkOverlayCtx,
  QuoteNode,
  type NodeActivateCtx,
  type NodeActivation,
  type NodeRegionCtx,
  type MountedEditor,
  Schema,
  type SchemaDefinitionOf,
  StrikeMark,
  StrongMark,
  TextNode,
} from "@cypherkit/editor";
import { CodeNode, type NodeOverlay } from "@cypherkit/editor/internal";
import {
  mathContentSelectionKind,
  mathInputRules,
  MathMark,
  MathNode,
} from "@cypherkit/editor/math";
import { appDataSchema } from "./appDataSchema";
import { getPlatform } from "@/platform";

/**
 * The app's image node: this device stores images by content hash (not as a
 * loadable URL), so the block's `url` is a content-addressed reference. The
 * engine never resolves assets itself — we override `resolveUrl` to map that
 * reference to a loadable blob URL via the platform asset store. Resolution is
 * lazy (called at image-load time) and per-instance (no module global).
 */
class CypherImageNode extends ImageNode {
  protected override resolveUrl(url: string): Promise<string> {
    return getPlatform().assets.getUrl(url);
  }

  // A placeholder image (no URL yet) opens the upload popover on click; an image
  // that already has a URL falls through to the engine's default (select block).
  override activate(c: NodeActivateCtx): NodeActivation | null {
    const block = c.block;
    if (block.type !== "image" || block.url) return null;
    return { key: "image-upload" };
  }

  /**
   * Declare the image upload/edit popover as a host overlay slot whenever the
   * active menu targets this block. The engine collects this through
   * `editor.host.collectOverlays()` and stays framework-free; the web app maps the
   * `"image-upload"` key to the React `ImageUploadPopover` (see `NODE_OVERLAYS`
   * in MountedEditor). The anchor is the canvas/container-space point the menu
   * was opened at; the upload status rides along as the overlay payload.
   */
  override overlays(c: NodeRegionCtx): readonly NodeOverlay[] {
    const { state } = c;
    const block = c.block;
    const menu = state.ui.activeMenu;
    const result: NodeOverlay[] = [];

    const menuOpen =
      menu.type === "overlay" &&
      menu.key === "image-upload" &&
      menu.blockId === c.block.id;

    // Upload/edit popover (drawer on mobile) when the menu targets this block.
    if (menuOpen) {
      const uploadStatus =
        (
          state.ui.nodeViewState[block.id] as
            | { uploadStatus?: "uploading" | "error" }
            | undefined
        )?.uploadStatus ?? "idle";
      result.push({
        key: "image-upload",
        blockId: c.block.id,
        rect: { x: menu.x, y: menu.y },
        data: { uploadStatus },
      });
    }

    // Hover chrome (download / edit buttons) over a non-placeholder image while
    // it's hovered or while its upload menu is open — landed on the image box.
    // Suppressed while a resize drag is in progress (the engine records the
    // active handle in this block's transient view-state).
    const isResizing = !!(
      state.ui.nodeViewState[block.id] as
        | { resizeHandle?: "left" | "right" | "bottom" }
        | undefined
    )?.resizeHandle;
    const hovered =
      state.ui.imageHover?.blockIndex === c.blockIndex && !isResizing;
    if (block.type === "image" && block.url && (hovered || menuOpen)) {
      result.push({
        key: "image-hover",
        blockId: c.block.id,
        rect: this.displayBox(c),
      });
    }

    return result;
  }
}

/**
 * Open the image upload/edit popover declared by {@link CypherImageNode}. The
 * typed opener lives next to the overlay's owner; it builds the opaque
 * opaque payload and hands it to the editor's generic `openOverlay`. The anchor
 * `(x, y)` is in canvas/container space (the overlay shifts it into viewport
 * space — see `ImageUploadOverlay`). Used by the host toolbar / edit-button path;
 * a placeholder image opens the same overlay via {@link CypherImageNode.activate}.
 */
export function openImageUploadMenu(
  editor: AppEditor,
  blockId: string,
  x: number,
  y: number,
): void {
  editor.host.openOverlay({ key: "image-upload", blockId, x, y });
}

/**
 * The app's link mark: the built-in {@link LinkMark} rendering, plus the link
 * hover tooltip and the link edit/create popover (drawer on mobile), declared as
 * host overlay slots. The tooltip rides the engine's `linkHover` hover state; the
 * editor rides the generic `"link-edit"` overlay. The web app maps the
 * `"link-tooltip"` / `"link-edit"` keys to the React components (`NODE_OVERLAYS`).
 */
class CypherLinkMark extends LinkMark {
  override overlays(c: MarkOverlayCtx): readonly NodeOverlay[] {
    const menu = c.state.ui.activeMenu;
    // The edit popover must take precedence over the hover tooltip. Opening the
    // popover does not synchronously clear linkHover, so checking hover first
    // leaves the tooltip mounted until the pointer moves again.
    if (menu.type === "overlay" && menu.key === "link-edit") {
      return [
        {
          key: "link-edit",
          blockId: menu.blockId,
          rect: { x: menu.x, y: menu.y },
          data: menu.data,
        },
      ];
    }

    const { linkHover } = c.state.ui;
    if (linkHover) {
      const blockId =
        c.state.document.page.blocks[linkHover.position.blockIndex]?.id ?? "";
      return [
        {
          key: "link-tooltip",
          blockId,
          rect: { x: linkHover.x, y: linkHover.y },
          data: {
            url: linkHover.url,
            text: linkHover.text,
            startIndex: linkHover.startIndex,
            endIndex: linkHover.endIndex,
          },
        },
      ];
    }
    return [];
  }
}

/** Host payload carried by the `"link-edit"` overlay (the engine treats it as
 * opaque `data`; the opener writes it and the React popover reads it). */
export interface LinkEditOverlayData {
  blockId: string;
  startIndex: number;
  endIndex: number;
  url: string;
  text: string;
  selectedText?: string;
}

/**
 * Open the link edit/create popover declared by {@link CypherLinkMark}. Pass
 * empty `url`/`text` with `selectedText` to create a new link from a selection.
 * Co-located with the overlay's owner; builds the opaque payload and hands it to
 * the editor's generic `openOverlay`. The anchor `(x, y)` is in canvas/container
 * space (the overlay shifts it into viewport space).
 */
export function openLinkEditMenu(
  editor: AppEditor,
  args: LinkEditOverlayData & { x: number; y: number },
): void {
  const { x, y, blockId, ...data } = args;
  editor.host.openOverlay({
    key: "link-edit",
    blockId,
    x,
    y,
    data: { blockId, ...data },
  });
}

/**
 * The app's code node: the built-in {@link CodeNode} plus a menu-driven `open`
 * flag on its `"code-language"` overlay slot. The engine node emits that slot for
 * every visible code block (the language chip is always available); this override
 * additionally marks it open whenever the active menu targets this block, so the
 * language picker can be opened as a drawer/sheet from the mobile keyboard
 * toolbar — not only via the chip's own tap. The flag rides the descriptor's
 * `data`, so toggling it re-renders the React overlay (see `CodeLanguageOverlay`
 * in MountedEditor).
 */
class CypherCodeNode extends CodeNode {
  override overlays(c: NodeRegionCtx): readonly NodeOverlay[] {
    const base = super.overlays(c);
    if (base.length === 0) return base;
    const menu = c.state.ui.activeMenu;
    return base.map((o) =>
      o.key === "code-language"
        ? {
            ...o,
            data: {
              open:
                menu.type === "overlay" &&
                menu.key === "code-language" &&
                menu.blockId === o.blockId,
            },
          }
        : o,
    );
  }
}

/**
 * Open the language-picker drawer declared by {@link CypherCodeNode}. Co-located
 * with the overlay's owner; hands the block off to the editor's generic
 * `openOverlay`. The picker is a bottom sheet on mobile, so the `(x, y)` anchor
 * is unused — pass `(0, 0)`. Used by the host keyboard toolbar's "code language"
 * button.
 */
export function openCodeLanguageMenu(editor: AppEditor, blockId: string): void {
  editor.host.openOverlay({ key: "code-language", blockId, x: 0, y: 0 });
}

/**
 * The block + inline-mark set this app supports.
 *
 * Declared explicitly here instead of relying on the engine's built-in
 * `baseSchema` default, so the host owns its schema: adding a custom block type
 * (`defineNode`) or mark (`defineMark`) — or dropping one the app doesn't want —
 * is a one-line edit in this file. It mirrors the built-in set, except the image
 * node is our hash-resolving {@link CypherImageNode}.
 *
 * The CRDT + serialization half is the app-owned `appDataSchema`: core data
 * plus the math data facets, each carried by the spec that owns it. The
 * interactive schema adds math's tree input rules, the clipboard selection
 * serializer (it needs the tex layout engine, so it stays out of worker
 * bundles), and the matching rendering node/mark view list. Reducers and
 * workers do not need those authoring facets to replay the resulting
 * structured operations.
 */
export const appSchema = new Schema(
  appDataSchema
    .extend({ structuredKinds: [mathContentSelectionKind] })
    .withFeatures({ inputRules: mathInputRules }),
  [
    new LineNode(),
    new CypherImageNode(),
    new MathNode(),
    new QuoteNode(),
    new TextNode(),
    new ListNode(),
    new CypherCodeNode(),
  ],
  [
    new StrongMark(),
    new EmphasisMark(),
    new StrikeMark(),
    new CodeMark(),
    new CypherLinkMark(),
    new MathMark(),
  ],
);

/** Public editor types specialized to the feature set this app installed. */
export type AppSchemaDefinition = SchemaDefinitionOf<typeof appSchema>;
export type AppEditor = Editor<AppSchemaDefinition>;
export type AppMountedEditor = MountedEditor<AppSchemaDefinition>;
