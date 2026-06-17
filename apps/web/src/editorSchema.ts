import {
  baseDataSchema,
  CodeMark,
  type Editor,
  EmphasisMark,
  ImageNode,
  LineNode,
  LinkMark,
  ListNode,
  type MarkOverlayCtx,
  MathMark,
  MathNode,
  type NodeActivateCtx,
  type NodeActivation,
  type NodeOverlay,
  type NodeRegionCtx,
  Schema,
  StrikeMark,
  StrongMark,
  TextNode,
} from "@cypherkit/editor";
import { getPlatform } from "@/platform";
import { CodeNode } from "@cypherkit/editor/nodes/CodeNode";

/**
 * The app's math node: the built-in {@link MathNode} rendering, plus the
 * block-math edit popover declared as a host overlay slot. When the active menu
 * targets this block, it declares a `"math-edit"` slot; the web app maps that
 * key to the React `MathBlockEditor` (see `NODE_OVERLAYS` in MountedEditor).
 * The engine stays framework-free — it only locates the slot at the anchor.
 */
class CypherMathNode extends MathNode {
  // Clicking a math block opens the block-math editor overlay.
  override activate(_c: NodeActivateCtx): NodeActivation | null {
    return { key: "math-edit" };
  }

  override overlays(c: NodeRegionCtx): readonly NodeOverlay[] {
    const menu = c.state.ui.activeMenu;
    if (
      menu.type !== "overlay" ||
      menu.key !== "math-edit" ||
      menu.blockId !== c.block.id
    ) {
      return [];
    }
    return [
      {
        key: "math-edit",
        blockId: c.block.id,
        rect: { x: menu.x, y: menu.y },
      },
    ];
  }
}

/**
 * The app's inline-math mark: the built-in {@link MathMark} rendering, plus the
 * inline-math edit popover declared as a host overlay slot. Inline math is a
 * run of `math`-marked characters inside a text block, so the editing chrome
 * belongs to the mark — not to any block node. Activating a chip opens the
 * generic `"inline-math-edit"` overlay (see {@link MathMark.editOverlayKey}),
 * carrying the run's range + latex; the web app maps that key to the React
 * `MathBlockEditor` (see `NODE_OVERLAYS` in MountedEditor).
 */
class CypherMathMark extends MathMark {
  override readonly editOverlayKey = "inline-math-edit";

  override overlays(c: MarkOverlayCtx): readonly NodeOverlay[] {
    const menu = c.state.ui.activeMenu;
    if (menu.type !== "overlay" || menu.key !== "inline-math-edit") {
      return [];
    }
    return [
      {
        key: "inline-math-edit",
        blockId: menu.blockId,
        rect: { x: menu.x, y: menu.y },
        data: menu.data,
      },
    ];
  }
}

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
   * `editor.collectOverlays()` and stays framework-free; the web app maps the
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
    const hovered =
      state.ui.imageHover?.blockIndex === c.blockIndex && !state.ui.imageDrag;
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
  editor: Editor,
  blockId: string,
  x: number,
  y: number,
): void {
  editor.openOverlay({ key: "image-upload", blockId, x, y });
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
    const menu = c.state.ui.activeMenu;
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
  editor: Editor,
  args: LinkEditOverlayData & { x: number; y: number },
): void {
  const { x, y, blockId, ...data } = args;
  editor.openOverlay({
    key: "link-edit",
    blockId,
    x,
    y,
    data: { blockId, ...data },
  });
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
 * The CRDT + serialization half stays `baseDataSchema` (the built-in block
 * descriptors/codecs are unchanged); what we own here is the rendering node/mark
 * view list. Pass `appSchema` to `useEditor({ schema })` and `appSchema.data` to
 * `createDoc({ schema })` so the editor view and the document agree.
 */
export const appSchema = new Schema(
  baseDataSchema,
  [
    new LineNode(),
    new CypherImageNode(),
    new CypherMathNode(),
    new TextNode(),
    new ListNode(),
    new CodeNode(),
  ],
  [
    new StrongMark(),
    new EmphasisMark(),
    new StrikeMark(),
    new CodeMark(),
    new CypherLinkMark(),
    new CypherMathMark(),
  ],
);
