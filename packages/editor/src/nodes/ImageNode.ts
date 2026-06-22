/**
 * ImageNode — the `image` block ported onto AtomicNode.
 *
 * What the port demonstrates beyond LineNode:
 *  - Non-trivial geometry (centering, full-width bleed, drawn rect ≠ flow box),
 *    computed ONCE in `geometry()` and shared by the height pass and paint —
 *    the layout/paint split removes the duplication that previously existed
 *    between renderImageBlock and the height pass.
 *  - `paintBox()` override: the painted/selected rect differs from the flow box.
 *  - `adjustFlowHeight()`: a first full-width image bleeds into the top padding,
 *    so it advances the document by less than it draws.
 *  - Block-owned chrome (resize drag handles) drawn from UI state.
 *
 * The resize-handle drag — the `*_IMAGE_HANDLE_DRAG` actions plus their thin
 * `*ImageHandleDrag` dispatch wrappers — lives at the bottom of this file, so
 * the drag logic travels with the node. The event layer (mouseEvents /
 * blockRegions / events) only resolves pointer hits and calls those wrappers.
 *
 * The serialization methods are this node's markdown/HTML/text round-trip
 * (`![alt](url)` / `<img>`), adapted into a BlockCodec by the schema.
 *
 * The escape-hatch rule, stated once: emit native markdown (`![alt](url)`)
 * when the block is losslessly representable in markdown, fall back to an
 * `<img>` HTML tag when it carries props markdown can't express
 * (width/height/objectFit). A future video block is the degenerate case of
 * the same rule — always the HTML branch.
 *
 * All emitted urls go through `ctx.mapAssetUrl`, so export flows decide what
 * an asset reference becomes (kept as-is, bundle-relative path, data URI).
 */

import { type ActionBus, stateAction } from "../action-bus";
import { POINTER_MOVE, TEXT_CLICK } from "../actions/pointer-actions";
import { EDGE_SCROLL_THRESHOLD, IMAGE_DEFAULT_HEIGHT } from "../constants";
import {
  startAutoScroll,
  stopAutoScroll,
  withScrollbarInteraction,
  withStoppedMomentum,
} from "../events/interaction-session";
import { AtomicNode } from "../rendering/nodes/AtomicNode";
import type {
  BlockRuntimeState,
  NodeHitRegion,
  NodeLayoutCtx,
  NodePaintCtx,
  NodeRegionCtx,
  Point,
} from "../rendering/nodes/Node";
import { hitRegion } from "../rendering/nodes/Node";
import { invalidateBlockCache } from "../rendering/renderer";
import { clearSelection, moveCursorToPosition } from "../selection";
import { escapeAttr } from "../serlization/codecs/inline";
import type {
  InputCtx,
  OutputCtx,
  ParsedTag,
} from "../serlization/codecs/types";
import type { Block } from "../serlization/loadPage";
import {
  IMAGE_ALT_END,
  IMAGE_END,
  IMAGE_START,
  NEWLINE,
  TEXT,
  type TokenType,
  type VisibleToken,
} from "../serlization/tokenizer";
import type {
  BlockBounds,
  CRDTbinding,
  EditorState,
  EditorStyles,
  ImageHoverState,
  Operation,
  ViewportState,
} from "../state-types";
import { updateMode } from "../state-utils";
import { getEditorStyles } from "../styles";

// Image block — an embedded image.
// Note: cachedLayout (from BlockRuntimeState) is transient runtime state, not
// persisted.
export interface Image extends BlockRuntimeState {
  type: "image";
  url: string;
  alt?: string;
  // Image dimensions - if not specified, defaults to cover mode with full width and default height
  width?: number | "full"; // Width in pixels or 'full' for edge-to-edge
  height?: number; // Height in pixels (only used in cover mode)
  objectFit?: "cover" | "contain"; // How image should be fitted
}

// ── Image asset cache ──────────────────────────────────────────────────────
// Co-located with the image block: this is image-only state. Shared as module
// singletons because one decode must serve every image block (and the event /
// export layers, which import `imageCache` via renderer's re-export).

/** Decoded images, keyed by url/asset-hash. */
export const imageCache = new Map<string, HTMLImageElement>();
/** Urls that failed to load — avoids hammering a broken source. */
const failedImageCache = new Set<string>();
/** In-flight loads, so concurrent blocks dedupe onto one decode. */
const pendingLoads = new Map<string, Promise<HTMLImageElement>>();

/** Clear a failed url (or all) so a retry can re-attempt the load. */
export function clearFailedImageCache(url?: string): void {
  if (url) {
    failedImageCache.delete(url);
  } else {
    failedImageCache.clear();
  }
}

/**
 * Load + cache an image. Resolves once decoded; the caller drives any redraw.
 * `resolve` maps a (possibly content-addressed) url to a loadable one — it is the
 * node's own {@link ImageNode.resolveUrl} hook, so the engine itself never
 * resolves assets. Only invoked for sources that aren't already loadable urls.
 */
function loadImage(
  url: string,
  resolve: (url: string) => string | Promise<string>,
): Promise<HTMLImageElement> {
  if (failedImageCache.has(url)) {
    return Promise.reject(new Error(`Image previously failed to load: ${url}`));
  }

  const existing = imageCache.get(url);
  if (existing && existing.complete) {
    return Promise.resolve(existing);
  }

  const inFlight = pendingLoads.get(url);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    const isAlreadyUrl =
      url.startsWith("blob:") ||
      url.startsWith("data:") ||
      url.startsWith("http://") ||
      url.startsWith("https://");
    let resolvedUrl = url;
    if (!isAlreadyUrl) {
      try {
        resolvedUrl = await resolve(url);
      } catch {
        // Asset not found — use as-is.
      }
    }
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      if (isAlreadyUrl) {
        img.crossOrigin = "anonymous";
      }

      img.onload = () => {
        imageCache.set(url, img);
        pendingLoads.delete(url);
        resolve(img);
      };

      img.onerror = () => {
        failedImageCache.add(url);
        pendingLoads.delete(url);
        reject(new Error(`Failed to load image: ${url}`));
      };

      img.src = resolvedUrl;

      // Already complete from the browser cache — resolve immediately.
      if (img.complete) {
        imageCache.set(url, img);
        pendingLoads.delete(url);
        resolve(img);
      }
    });
  })();

  pendingLoads.set(url, promise);
  return promise;
}

interface ImageGeometry {
  readonly displayX: number;
  readonly displayWidth: number;
  /** Drawn image height, excluding the trailing flow padding. */
  readonly displayHeight: number;
}

/**
 * Which resize drag handle (if any) is under the pointer, given the drawn
 * image rect. `extraTolerance` widens the hit area beyond the visible bar
 * (mouse: 4px, touch: 12px).
 */
export function getDragHandleAtPoint(
  x: number,
  y: number,
  imageX: number,
  imageY: number,
  imageWidth: number,
  imageHeight: number,
  objectFit: "cover" | "contain" = "cover",
  extraTolerance: number = 4,
): "left" | "right" | "bottom" | null {
  // No `state` in scope here; imageResize styles have no per-instance overrides,
  // so the default-resolved styles are equivalent.
  const styles = getEditorStyles();
  const { vertical, horizontal } = styles.imageResize.dragHandles;

  // Extra tolerance for easier hovering/tapping (pixels beyond the visible bar)
  const tolerance = extraTolerance;

  // Left vertical bar (centered vertically with specified length)
  const leftBarX = imageX + vertical.inset;
  const leftBarWidth = vertical.thickness;
  const leftBarY = imageY + (imageHeight - vertical.length) / 2; // Center vertically
  const leftBarHeight = vertical.length;

  if (
    x >= leftBarX - tolerance &&
    x <= leftBarX + leftBarWidth + tolerance &&
    y >= leftBarY &&
    y <= leftBarY + leftBarHeight
  ) {
    return "left";
  }

  // Right vertical bar (centered vertically with specified length)
  const rightBarX = imageX + imageWidth - vertical.inset - vertical.thickness;
  const rightBarWidth = vertical.thickness;
  const rightBarY = imageY + (imageHeight - vertical.length) / 2; // Center vertically
  const rightBarHeight = vertical.length;

  if (
    x >= rightBarX - tolerance &&
    x <= rightBarX + rightBarWidth + tolerance &&
    y >= rightBarY &&
    y <= rightBarY + rightBarHeight
  ) {
    return "right";
  }

  // Bottom horizontal bar (centered horizontally with specified length)
  // Only active in cover mode
  if (objectFit === "cover") {
    const bottomBarX = imageX + (imageWidth - horizontal.length) / 2; // Center horizontally
    const bottomBarWidth = horizontal.length;
    const bottomBarY =
      imageY + imageHeight - horizontal.inset - horizontal.thickness;
    const bottomBarHeight = horizontal.thickness;

    if (
      x >= bottomBarX &&
      x <= bottomBarX + bottomBarWidth &&
      y >= bottomBarY - tolerance &&
      y <= bottomBarY + bottomBarHeight + tolerance
    ) {
      return "bottom";
    }
  }

  return null;
}

/**
 * Whether an image block is in default visual state (cover mode, full width,
 * default height) and thus losslessly representable as `![alt](url)`.
 * Serialization policy — lives with the node.
 */
export function isImageDefault(block: Image): boolean {
  const width = block.width ?? "full";
  const height = block.height ?? IMAGE_DEFAULT_HEIGHT;
  const objectFit = block.objectFit ?? "cover";

  return (
    width === "full" && height === IMAGE_DEFAULT_HEIGHT && objectFit === "cover"
  );
}

/** The resolved start descriptor of an in-progress resize drag. Lives on the
 *  captured hit (per-drag, node-owned) — there is no global UI slot for it. */
interface ImageDragStart {
  handle: "left" | "right" | "bottom";
  startX: number;
  startY: number;
  startWidth: number | "full";
  startHeight: number;
  startObjectFit: "cover" | "contain";
}

/** Hit data the image-resize region's hitTest returns to its drag spec. */
interface ImageResizeHit {
  blockIndex: number;
  box: { x: number; y: number; width: number; height: number };
  handle: "left" | "right" | "bottom";
  /** Filled in `onStart`; read by `onMove`/`onEnd`/`onCancel` + the auto-scroll
   *  hooks off `ctx.session.captured.hit`. Absent during pure hover hit-tests. */
  start?: ImageDragStart;
}

/**
 * The image node's transient per-block view-state (the value stored at
 * `ui.nodeViewState[block.id]`). `uploadStatus` is set host-side by the upload
 * flow; `resizeHandle` is set by the engine while a resize drag is in progress
 * (which handle is active) so the renderer can highlight it — the render-visible
 * replacement for the former `ui.imageDrag`. Writers MUST merge (not overwrite)
 * so the two concerns don't clobber each other.
 */
export interface ImageViewState {
  uploadStatus?: "uploading" | "error";
  resizeHandle?: "left" | "right" | "bottom";
}

/** Merge a resize-handle highlight into a block's `nodeViewState` slot (or clear
 *  it with `handle: null`), preserving any host-set `uploadStatus`. */
function setImageResizeHandle(
  state: EditorState,
  blockId: string,
  handle: "left" | "right" | "bottom" | null,
): EditorState {
  const prev = state.ui.nodeViewState[blockId] as ImageViewState | undefined;
  const next: ImageViewState = { ...prev };
  if (handle === null) delete next.resizeHandle;
  else next.resizeHandle = handle;
  return {
    ...state,
    ui: {
      ...state.ui,
      nodeViewState: { ...state.ui.nodeViewState, [blockId]: next },
    },
  };
}

/**
 * Whether a bottom-handle resize should stop scrolling down: once a cover-mode
 * image is at its natural max height, scrolling further would chase its own
 * resize. Shared by the drag's immediate move and the auto-scroll tick.
 */
function shouldBlockBottomScroll(
  block: Image,
  start: ImageDragStart,
  pointerY: number,
  viewport: ViewportState,
): boolean {
  if (start.handle !== "bottom") return false;
  if ((block.objectFit ?? "cover") !== "cover" || !block.url) return false;
  const cachedImage = imageCache.get(block.url);
  if (!cachedImage || !cachedImage.complete) return false;
  const imgAspectRatio = cachedImage.naturalWidth / cachedImage.naturalHeight;
  const containerWidth =
    typeof block.width === "number" ? block.width : viewport.width;
  const maxHeightForRatio = containerWidth / imgAspectRatio;
  const currentHeight = start.startHeight + (pointerY - start.startY);
  const isAtMaxHeight = currentHeight >= maxHeightForRatio - 1;
  const isNearBottomEdge =
    pointerY > viewport.height - EDGE_SCROLL_THRESHOLD ||
    pointerY > viewport.height;
  return isAtMaxHeight && isNearBottomEdge;
}

export class ImageNode extends AtomicNode<Image> {
  readonly type = "image" as const;

  /**
   * The image block's localized canvas strings (status labels), owned by the
   * node rather than the global string table. English defaults; a host
   * localizes per instance via `theme.nodeStrings.image`. Read with `this.str`.
   */
  readonly strings = {
    clickToUpload: "Click to upload image",
    loading: "Loading image...",
    uploading: "Uploading image...",
    uploadFailed: "Failed to upload image",
    clickToRetry: "Click to retry",
    changeImage: "Change Image",
  } as const;

  /**
   * Map a block's `url` to a loadable one, just before the image is fetched.
   * Default: identity — the engine treats `block.url` as a normal, loadable URL
   * and never resolves assets itself. A host whose image blocks store a
   * content-addressed reference (not a `blob:`/`data:`/`http(s):` URL) subclasses
   * this node, overrides `resolveUrl` to map that reference to a loadable URL
   * (e.g. its platform asset store), and registers the subclass in its schema.
   * Only called for sources that aren't already loadable URLs.
   */
  protected resolveUrl(url: string): string | Promise<string> {
    return url;
  }

  /**
   * Resolve the on-canvas geometry from block props + container width. Depends
   * only on layout context (no origin), so both the height pass and paint use it.
   */
  private geometry(c: NodeLayoutCtx): ImageGeometry {
    const block = c.block as Image;
    const styles = c.styles;
    const { height: defaultImageHeight, placeholderHeight } =
      styles.blocks.image.dimensions;

    const imageWidth = block.width ?? "full";
    const imageHeight = block.height ?? defaultImageHeight;

    if (imageWidth === "full") {
      // Full width: edge-to-edge, ignoring page padding.
      return {
        displayX: 0,
        displayWidth:
          c.maxWidth + styles.canvas.paddingLeft + styles.canvas.paddingRight,
        displayHeight: block.url ? imageHeight : placeholderHeight,
      };
    }

    // Custom width: respect padding, constrain to container, center.
    const requestedWidth = imageWidth;
    const displayWidth = Math.min(requestedWidth, c.maxWidth);
    const displayX =
      styles.canvas.paddingLeft + (c.maxWidth - displayWidth) / 2;

    // Adjust height proportionally if the width was constrained, so images
    // resized on desktop don't get distorted on mobile.
    const displayHeight =
      block.url && displayWidth < requestedWidth
        ? imageHeight * (displayWidth / requestedWidth)
        : block.url
          ? imageHeight
          : placeholderHeight;

    return { displayX, displayWidth, displayHeight };
  }

  protected intrinsicHeight(c: NodeLayoutCtx): number {
    // Always add padding after image blocks for visual spacing.
    return (
      this.geometry(c).displayHeight +
      c.styles.blocks.image.dimensions.paddingBottom
    );
  }

  protected paintBox(c: NodePaintCtx): BlockBounds {
    return this.displayBox(c);
  }

  /**
   * The drawn image rect in `c`'s origin space — a first full-width image bleeds
   * up into the top padding for an edge-to-edge look (it keeps its drawn
   * dimensions but starts higher). Shared by paint ({@link paintBox}) and
   * overlay positioning, so a subclass can land host chrome (e.g. hover
   * buttons) exactly on the image. Accepts any ctx with an `origin` — both
   * `NodePaintCtx` and `NodeRegionCtx` qualify.
   */
  protected displayBox(c: NodeLayoutCtx & { origin: Point }): BlockBounds {
    const { displayX, displayWidth, displayHeight } = this.geometry(c);
    const shouldBleed =
      c.isFirst && ((c.block as Image).width ?? "full") === "full";
    const y = shouldBleed
      ? c.origin.y - c.styles.canvas.paddingTop
      : c.origin.y;
    return { x: displayX, y, width: displayWidth, height: displayHeight };
  }

  adjustFlowHeight(height: number, c: NodeLayoutCtx): number {
    const imageWidth = (c.block as Image).width ?? "full";
    if (c.isFirst && imageWidth === "full") {
      return height - c.styles.canvas.paddingTop;
    }
    return height;
  }

  /**
   * The resize drag handles are an interactive sub-region that carries its own
   * drag behavior: hit-test resolves the handle, and the drag spec records the
   * resize (with edge auto-scroll), dispatching the `*_IMAGE_HANDLE_DRAG`
   * actions defined below. The event layer (blockRegions) binds this directly —
   * no id→behavior table.
   */
  regions(c: NodeRegionCtx): readonly NodeHitRegion[] {
    return [
      hitRegion({
        id: "image-resize",
        priority: 60,
        modes: ["edit", "select"],
        hitTest: (p, pointerType): ImageResizeHit | null => {
          const block = c.block as Image;
          if (!block.url) return null;
          const box = this.hitTestBox(c, c.origin, p);
          if (!box) return null;
          const handle = getDragHandleAtPoint(
            p.x,
            p.y,
            box.x,
            box.y,
            box.width,
            box.height,
            block.objectFit ?? "cover",
            pointerType === "touch" ? 12 : 4,
          );
          return handle ? { blockIndex: c.blockIndex, box, handle } : null;
        },
        drag: {
          onStart(h, p, ctx) {
            // Tolerance 12 covers both pointer types — the hit test already
            // applied the per-pointer slop, this only re-derives the handle.
            const started = startImageHandleDrag(
              ctx.state,
              { blockIndex: h.blockIndex, ...h.box },
              p.x,
              p.y,
              12,
            );
            if (!started) return null;
            // Stash the resolved start descriptor on the captured hit so the
            // move/end/auto-scroll handlers read it without a global UI slot.
            h.start = started.start;
            return {
              state: withScrollbarInteraction(
                withStoppedMomentum(started.state),
              ),
            };
          },
          onMove(p, ctx) {
            const { state, viewport, session } = ctx;
            const h = session.captured?.hit as ImageResizeHit | undefined;
            if (!h?.start) return { state };
            const block = state.document.page.blocks[h.blockIndex];
            if (!block || block.deleted || block.type !== "image") {
              return { state };
            }

            // Bottom handle: once the image is at its natural max height, stop
            // auto-scrolling down (otherwise the drag chases its own scroll).
            const blockBottom = shouldBlockBottomScroll(
              block,
              h.start,
              p.y,
              viewport,
            );

            // Edge auto-scroll: record the pointer so the frame loop in
            // handleEvents keeps scrolling (and resizing) while the pointer
            // holds still at the edge.
            const isNearTopEdge = p.y < EDGE_SCROLL_THRESHOLD || p.y < 0;
            const isNearBottomEdge =
              p.y > viewport.height - EDGE_SCROLL_THRESHOLD ||
              p.y > viewport.height;
            if (
              (isNearTopEdge || isNearBottomEdge) &&
              !(blockBottom && isNearBottomEdge)
            ) {
              startAutoScroll(session);
              session.autoScroll.lastPointerX = p.x;
              session.autoScroll.lastPointerY = p.y;
            } else if (session.autoScroll.isActive) {
              stopAutoScroll(session);
            }

            return {
              state: withScrollbarInteraction(
                updateImageHandleDrag(
                  state,
                  viewport,
                  p.x,
                  p.y,
                  h.blockIndex,
                  h.start,
                ),
              ),
            };
          },
          onEnd(_p, ctx) {
            stopAutoScroll(ctx.session);
            const h = ctx.session.captured?.hit as ImageResizeHit | undefined;
            if (!h?.start) return { state: ctx.state };
            const result = endImageHandleDrag(ctx.state, h.blockIndex, h.start);
            return {
              state: withScrollbarInteraction(result.state),
              ops: result.ops,
            };
          },
          onCancel(ctx) {
            stopAutoScroll(ctx.session);
            const h = ctx.session.captured?.hit as ImageResizeHit | undefined;
            if (!h) return ctx.state;
            return cancelImageHandleDrag(ctx.state, h.blockIndex);
          },
          onAutoScrollTick(p, ctx) {
            const h = ctx.session.captured?.hit as ImageResizeHit | undefined;
            const block = h
              ? ctx.state.document.page.blocks[h.blockIndex]
              : undefined;
            if (
              !h?.start ||
              !block ||
              block.deleted ||
              block.type !== "image"
            ) {
              return { blockScroll: false };
            }
            return {
              blockScroll: shouldBlockBottomScroll(
                block,
                h.start,
                p.y,
                ctx.viewport,
              ),
            };
          },
          onAutoScrollScrolled(p, scrollDelta, ctx) {
            const h = ctx.session.captured?.hit as ImageResizeHit | undefined;
            if (!h?.start) return ctx.state;
            // Shift the drag origin by the scroll so the image keeps resizing
            // while the viewport scrolls under a stationary pointer.
            h.start = { ...h.start, startY: h.start.startY - scrollDelta };
            return updateImageHandleDrag(
              ctx.state,
              ctx.viewport,
              p.x,
              p.y,
              h.blockIndex,
              h.start,
            );
          },
        },
      }),
    ];
  }

  /**
   * Register the image node's pointer/click handlers:
   *  - `POINTER_MOVE` (observe, priority 0) — highlight the image (and any resize
   *    handle under the pointer) when over an image block; clear otherwise. Owns
   *    the `ui.imageHover` slot via {@link SET_IMAGE_HOVER}.
   *  - `TEXT_CLICK` (claim, priority 50) — a click/tap that resolved to a caret on
   *    a *trailing* image block (its flow area / below all content, not the image
   *    visual — that's handled by `activate`) appends a paragraph below it. This is
   *    the generic replacement for the old `block.type === "image"` branches in
   *    the touch handler, and brings desktop click to parity with touch.
   */
  registerActions(bus: ActionBus): void {
    bus.registerState(
      POINTER_MOVE,
      (state, { atomicBlock, canvasX, canvasY }) => {
        const block =
          atomicBlock &&
          state.document.page.blocks[atomicBlock.blockIndex]?.type === "image"
            ? atomicBlock
            : null;
        if (!block) {
          return {
            state: state.actionBus.dispatchState(SET_IMAGE_HOVER, state, {
              imageHover: null,
            }).state,
            ops: [],
          };
        }
        const imageBlock = state.document.page.blocks[
          block.blockIndex
        ] as Image;
        const objectFit = imageBlock.objectFit ?? "cover";
        const hoveredHandle = getDragHandleAtPoint(
          canvasX,
          canvasY,
          block.x,
          block.y,
          block.width,
          block.height,
          objectFit,
        );
        return {
          state: state.actionBus.dispatchState(SET_IMAGE_HOVER, state, {
            imageHover: {
              blockIndex: block.blockIndex,
              x: block.x,
              y: block.y,
              width: block.width,
              height: block.height,
              hoveredHandle,
            },
          }).state,
          ops: [],
        };
      },
      0,
    );

    bus.registerState(
      TEXT_CLICK,
      (state, { position }) => {
        if (state.ui.mode === "readonly") return;
        const blocks = state.document.page.blocks;
        const block = blocks[position.blockIndex];
        if (!block || block.type !== "image") return;
        // Only the trailing visible block creates a paragraph below it.
        const visible = state.view.visibleBlocks;
        const lastVisibleId =
          visible.length > 0 ? visible[visible.length - 1].id : null;
        if (!lastVisibleId || block.id !== lastVisibleId) return;
        const created = state.actionBus.dispatchState(
          CREATE_PARAGRAPH_BELOW_IMAGE,
          state,
          {
            afterBlock: block,
            afterBlockIndex: position.blockIndex,
            binding: state.CRDTbinding,
          },
        );
        return { state: created.state, ops: created.ops, handled: true };
      },
      50,
    );
  }

  /**
   * The pointer hits the image when it is anywhere inside the container box
   * (including a first full-width image's bleed into the top padding). The
   * returned box is the actually-drawn image rect: in contain mode it shrinks
   * to the decoded aspect ratio so resize handles align with the visible image.
   */
  hitTestBox(
    c: NodeLayoutCtx,
    origin: Point,
    point: Point,
  ): BlockBounds | null {
    const block = c.block as Image;
    const { displayX, displayWidth, displayHeight } = this.geometry(c);

    const shouldBleed = c.isFirst && (block.width ?? "full") === "full";
    const boxY = shouldBleed ? origin.y - c.styles.canvas.paddingTop : origin.y;
    const inside =
      point.x >= displayX &&
      point.x < displayX + displayWidth &&
      point.y >= boxY &&
      point.y < boxY + displayHeight;
    if (!inside) return null;

    let finalX = displayX;
    let finalY = boxY;
    let finalWidth = displayWidth;
    let finalHeight = displayHeight;

    if ((block.objectFit ?? "cover") === "contain" && block.url) {
      const cachedImage = imageCache.get(block.url);
      if (cachedImage && cachedImage.complete) {
        const imgAspectRatio =
          cachedImage.naturalWidth / cachedImage.naturalHeight;
        const containerAspectRatio = displayWidth / displayHeight;

        if (imgAspectRatio > containerAspectRatio) {
          // Image is wider than container - fit to width
          finalHeight = displayWidth / imgAspectRatio;
          finalY = boxY + (displayHeight - finalHeight) / 2;
        } else {
          // Image is taller than container - fit to height
          finalWidth = displayHeight * imgAspectRatio;
          finalX = displayX + (displayWidth - finalWidth) / 2;
        }
      }
    }

    return { x: finalX, y: finalY, width: finalWidth, height: finalHeight };
  }

  protected draw(box: BlockBounds, c: NodePaintCtx): void {
    const block = c.block as Image;
    const { ctx, state, styles } = c;
    const objectFit = block.objectFit ?? "cover";
    const { x, y, width, height } = box;

    // Upload status from transient per-block view-state (set by the host upload
    // flow via `editor.setNodeViewState`). Not modelled as a menu/overlay.
    const uploadStatus = (
      state.ui.nodeViewState[block.id] as
        | { uploadStatus?: "uploading" | "error" }
        | undefined
    )?.uploadStatus;

    if (uploadStatus === "uploading") {
      this.drawStatus(
        c,
        box,
        styles.blocks.image.uploading.backgroundColor,
        [{ text: this.str(state, "uploading"), dy: 0 }],
        styles.blocks.image.uploading.textColor,
      );
    } else if (uploadStatus === "error") {
      this.drawStatus(
        c,
        box,
        styles.blocks.image.error.backgroundColor,
        [
          { text: this.str(state, "uploadFailed"), dy: 0 },
          { text: this.str(state, "clickToRetry"), dy: 20 },
        ],
        styles.blocks.image.error.textColor,
      );
    } else if (block.url) {
      if (failedImageCache.has(block.url)) {
        this.drawStatus(
          c,
          box,
          styles.blocks.image.error.backgroundColor,
          [
            { text: this.str(state, "uploadFailed"), dy: 0 },
            { text: this.str(state, "clickToRetry"), dy: 20 },
          ],
          styles.blocks.image.error.textColor,
        );
      } else {
        const cachedImage = imageCache.get(block.url);
        if (cachedImage && cachedImage.complete) {
          this.drawImage(c, box, cachedImage, objectFit);
        } else {
          this.drawStatus(
            c,
            box,
            styles.blocks.image.loading.backgroundColor,
            [{ text: this.str(state, "loading"), dy: 0 }],
            styles.blocks.image.loading.textColor,
          );
          loadImage(block.url, (url) => this.resolveUrl(url))
            .then(() => {
              // The decoded size may differ from the placeholder — drop the
              // cached layout so it recomputes, then ask for a repaint.
              invalidateBlockCache(block);
              c.requestRedraw();
            })
            .catch((error) => {
              console.error("Failed to load image:", error);
              // Repaint so the error state shows.
              c.requestRedraw();
            });
        }
      }
    } else {
      // No image yet — dashed upload prompt.
      ctx.fillStyle = styles.blocks.image.placeholder.backgroundColor;
      ctx.fillRect(x, y, width, height);
      ctx.strokeStyle = styles.blocks.image.placeholder.borderColor;
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, width, height);
      ctx.setLineDash([]);
      ctx.fillStyle = styles.blocks.image.placeholder.textColor;
      ctx.font = "14px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        this.str(state, "clickToUpload"),
        x + width / 2,
        y + height / 2,
      );
    }
  }

  protected drawChrome(box: BlockBounds, c: NodePaintCtx): void {
    const objectFit = (c.block as Image).objectFit ?? "cover";
    this.drawDragHandles(c, box, objectFit);
  }

  private drawStatus(
    c: NodePaintCtx,
    box: BlockBounds,
    bg: string,
    lines: ReadonlyArray<{ text: string; dy: number }>,
    textColor: string,
  ): void {
    const { ctx } = c;
    const { x, y, width, height } = box;
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = textColor;
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    for (const line of lines) {
      ctx.fillText(line.text, x + width / 2, y + height / 2 + line.dy);
    }
  }

  private drawImage(
    c: NodePaintCtx,
    box: BlockBounds,
    img: HTMLImageElement,
    objectFit: "cover" | "contain",
  ): void {
    const { ctx, styles } = c;
    const { x, y, width, height } = box;
    const imgAspectRatio = img.naturalWidth / img.naturalHeight;
    const containerAspectRatio = width / height;

    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = img.naturalWidth;
    let sourceHeight = img.naturalHeight;
    let destX = x;
    let destY = y;
    let destWidth = width;
    let destHeight = height;

    if (objectFit === "cover") {
      // Crop the image to fill the container.
      if (imgAspectRatio > containerAspectRatio) {
        sourceWidth = img.naturalHeight * containerAspectRatio;
        sourceX = (img.naturalWidth - sourceWidth) / 2;
      } else {
        sourceHeight = img.naturalWidth / containerAspectRatio;
        sourceY = (img.naturalHeight - sourceHeight) / 2;
      }
    } else {
      // Fit the entire image, maintaining aspect ratio.
      if (imgAspectRatio > containerAspectRatio) {
        destHeight = width / imgAspectRatio;
        destY = y + (height - destHeight) / 2;
      } else {
        destWidth = height * imgAspectRatio;
        destX = x + (width - destWidth) / 2;
      }
    }

    ctx.fillStyle = styles.blocks.image.loading.backgroundColor;
    ctx.fillRect(x, y, width, height);
    ctx.drawImage(
      img,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      destX,
      destY,
      destWidth,
      destHeight,
    );
  }

  private drawDragHandles(
    c: NodePaintCtx,
    box: BlockBounds,
    objectFit: "cover" | "contain",
  ): void {
    const { state, blockIndex } = c;
    const block = c.block as Image;
    // The active resize handle (while dragging) lives in this block's transient
    // view-state; hover handles live in `ui.imageHover`.
    const draggingHandle = (
      state.ui.nodeViewState[block.id] as ImageViewState | undefined
    )?.resizeHandle;
    const isHovering =
      !!state.ui.imageHover && state.ui.imageHover.blockIndex === blockIndex;
    const shouldRender = (isHovering || !!draggingHandle) && !!block.url;
    if (!shouldRender) return;

    let hoveredHandle: "left" | "right" | "bottom" | null = null;
    if (draggingHandle) {
      hoveredHandle = draggingHandle;
    } else if (isHovering) {
      hoveredHandle = state.ui.imageHover!.hoveredHandle;
    }

    renderImageDragHandles(
      c.ctx,
      box.x,
      box.y,
      box.width,
      box.height,
      objectFit,
      hoveredHandle,
      c.styles,
    );
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  readonly markdownTokens: readonly TokenType[] = [IMAGE_START];
  readonly htmlTags: readonly string[] = ["img"];

  outputMarkdown(block: Image, ctx: OutputCtx): string {
    const b = block;
    const alt = b.alt || "";
    const src = ctx.mapAssetUrl(b.url);

    // If image is in default state, use markdown syntax
    if (isImageDefault(b)) {
      return `![${alt}](${src})`;
    }

    // Otherwise, use HTML tag with custom properties
    const width = b.width ?? "full";
    const height = b.height ?? IMAGE_DEFAULT_HEIGHT;
    const objectFit = b.objectFit ?? "cover";

    const widthAttr =
      width === "full" ? 'data-width="full"' : `width="${width}"`;
    const heightAttr = `height="${height}"`;
    const objectFitAttr = `data-object-fit="${objectFit}"`;
    const altAttr = alt ? ` alt="${alt}"` : "";

    return `<img src="${src}"${altAttr} ${widthAttr} ${heightAttr} ${objectFitAttr} />`;
  }

  // ![alt](url)
  inputMarkdown(ctx: InputCtx): Block {
    ctx.match(IMAGE_START); // Consume ![

    let altText = "";
    let imageUrl = "";

    // Get alt text
    if (!ctx.isEnd() && ctx.check(TEXT)) {
      ctx.advance();
      altText = (ctx.previous() as VisibleToken).content;
    }

    // Consume ](
    ctx.match(IMAGE_ALT_END);

    // Get URL
    if (!ctx.isEnd() && ctx.check(TEXT)) {
      ctx.advance();
      imageUrl = (ctx.previous() as VisibleToken).content;
    }

    // Consume )
    ctx.match(IMAGE_END);

    // Consume optional newline
    ctx.match(NEWLINE);

    const image: Image = {
      id: ctx.nextBlockId(),
      type: "image",
      url: imageUrl,
      alt: altText,
      // Default properties - not specified in markdown
    };
    return image;
  }

  // <img src="url" alt="alt" width="..." height="..." data-object-fit="..." />
  inputMarkdownTag(tag: ParsedTag, ctx: InputCtx): Block {
    const { attrs } = tag;

    const widthRaw = attrs["width"] ?? attrs["data-width"];
    const width = widthRaw
      ? widthRaw === "full"
        ? ("full" as const)
        : parseInt(widthRaw, 10)
      : undefined;
    const height = attrs["height"] ? parseInt(attrs["height"], 10) : undefined;
    const objectFit = attrs["data-object-fit"]
      ? (attrs["data-object-fit"] as "cover" | "contain")
      : undefined;

    // Consume optional newline
    ctx.match(NEWLINE);

    const image: Image = {
      id: ctx.nextBlockId(),
      type: "image",
      url: attrs["src"] ?? "",
      alt: attrs["alt"] ?? "",
      width,
      height,
      objectFit,
    };
    return image;
  }

  outputHTML(block: Image, ctx: OutputCtx): string {
    const b = block;
    const src = ctx.mapAssetUrl(b.url);
    const alt = b.alt ? escapeAttr(b.alt) : "";
    const styles: string[] = [
      "max-width:100%",
      "height:auto",
      "display:block",
      "margin:1em auto",
    ];

    if (!isImageDefault(b)) {
      if (typeof b.width === "number") styles.push(`width:${b.width}px`);
      const fit = b.objectFit ?? "cover";
      styles.push(`object-fit:${fit}`);
    }

    return `<img src="${escapeAttr(src)}" alt="${alt}" style="${styles.join(";")}" />`;
  }

  outputText(block: Image): string {
    return block.alt || "";
  }

  assetRefs(block: Image): string[] {
    const url = block.url;
    return url ? [url] : [];
  }
}

/**
 * Draw resize drag handles for an image using exact dimensions. Moved verbatim
 * from renderer.ts (renderImageDragHandlesForBlock) so the chrome lives with
 * the block it belongs to.
 */
function renderImageDragHandles(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  objectFit: "cover" | "contain",
  hoveredHandle: "left" | "right" | "bottom" | null,
  styles: EditorStyles,
): void {
  const { vertical, horizontal } = styles.imageResize.dragHandles;
  const {
    color: outlineColor,
    width: outlineWidth,
    hoverOpacity: outlineHoverOpacity,
    dashPattern,
  } = styles.imageResize.outline;

  const showBottomHandle = objectFit === "cover"; // Only show bottom handle in cover mode

  ctx.save();

  const renderBar = (
    barX: number,
    barY: number,
    barWidth: number,
    barHeight: number,
    isHovered: boolean,
  ): void => {
    ctx.save();
    ctx.globalAlpha = isHovered ? vertical.hoverOpacity : vertical.opacity;
    ctx.fillStyle = isHovered
      ? vertical.hoverBackgroundColor
      : vertical.backgroundColor;
    if (vertical.borderRadius > 0) {
      ctx.beginPath();
      ctx.roundRect(barX, barY, barWidth, barHeight, vertical.borderRadius);
      ctx.fill();
    } else {
      ctx.fillRect(barX, barY, barWidth, barHeight);
    }
    ctx.restore();
  };

  // Left vertical bar
  renderBar(
    x + vertical.inset,
    y + (height - vertical.length) / 2,
    vertical.thickness,
    vertical.length,
    hoveredHandle === "left",
  );

  // Right vertical bar
  renderBar(
    x + width - vertical.inset - vertical.thickness,
    y + (height - vertical.length) / 2,
    vertical.thickness,
    vertical.length,
    hoveredHandle === "right",
  );

  // Bottom horizontal bar (cover mode only)
  if (showBottomHandle) {
    renderBar(
      x + (width - horizontal.length) / 2,
      y + height - horizontal.inset - horizontal.thickness,
      horizontal.length,
      horizontal.thickness,
      hoveredHandle === "bottom",
    );
  }

  // Subtle dashed outline when hovering any handle.
  if (hoveredHandle !== null) {
    ctx.save();
    ctx.globalAlpha = outlineHoverOpacity;
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = outlineWidth;
    ctx.setLineDash(dashPattern as number[]);
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]);
    ctx.restore();
  }

  ctx.restore();
}

// ─── Image actions ───────────────────────────────────────────────────────────
//
// The image-specific actions live with the node they act on. The resize-handle
// drag is named `*_IMAGE_HANDLE_DRAG` (not just "image-drag"): the bare term is
// reserved for a future move-the-image gesture, this is the resize-handle drag.
// The thin `*ImageHandleDrag` wrapper functions below resolve pointer/geometry
// data and dispatch these actions; they used to live in `events/eventUtils.ts`
// and moved here so the drag transforms travel with the node (the start wrapper
// reuses this file's local {@link getDragHandleAtPoint}, avoiding a cycle).

/**
 * Begin an image-resize drag: mark which handle of which block is active in the
 * block's transient view-state so the renderer highlights it. The drag's start
 * descriptor itself lives on the captured hit (not state) — this action only
 * records the render-visible highlight. Pure UI change, no ops.
 */
export const START_IMAGE_HANDLE_DRAG = stateAction<{
  blockIndex: number;
  handle: "left" | "right" | "bottom";
}>("start-image-handle-drag", (state, { blockIndex, handle }) => {
  const block = state.document.page.blocks[blockIndex];
  if (!block) return { state, ops: [] };
  return { state: setImageResizeHandle(state, block.id, handle), ops: [] };
});

/** Payload for {@link UPDATE_IMAGE_HANDLE_DRAG} — the live pointer + viewport
 *  plus the drag's start descriptor (sourced from the captured hit). */
export interface UpdateImageDragPayload extends ImageDragStart {
  viewport: ViewportState;
  canvasX: number;
  canvasY: number;
  blockIndex: number;
}

/**
 * Recompute the dragged image's dimensions from the current pointer position,
 * applying the resize math (handle direction, full-width snapping, aspect-ratio
 * height capping) and writing the new width/height/objectFit onto the block.
 * Pure block-dimension update — no ops; the final `block_set`s are emitted by
 * {@link END_IMAGE_HANDLE_DRAG} when the drag releases. No-op when the target
 * block is gone / not an image.
 */
export const UPDATE_IMAGE_HANDLE_DRAG = stateAction<UpdateImageDragPayload>(
  "update-image-handle-drag",
  (
    state,
    {
      viewport,
      canvasX,
      canvasY,
      blockIndex,
      handle,
      startX,
      startY,
      startWidth,
      startHeight,
      startObjectFit,
    },
  ) => {
    const block = state.document.page.blocks[blockIndex];
    if (!block || block.deleted) return { state, ops: [] };

    if (block.type !== "image") {
      return { state, ops: [] };
    }

    const styles = getEditorStyles(state);
    const deltaX = canvasX - startX;
    const deltaY = canvasY - startY;
    const maxWidth =
      viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
    const snapThreshold = 20; // pixels to snap to padding

    let newWidth: number | "full" = startWidth;
    let newHeight = startHeight;
    let newObjectFit: "cover" | "contain" = startObjectFit;

    if (handle === "left" || handle === "right") {
      // Horizontal resize
      const widthDelta = handle === "left" ? -deltaX * 2 : deltaX * 2; // multiply by 2 because we resize from center
      const { minWidth: constraintMinWidth } = styles.imageResize.constraints;

      if (startWidth === "full") {
        // Start from full width
        const currentWidth = viewport.width;
        newWidth = Math.max(constraintMinWidth, currentWidth + widthDelta);

        // Check if we should snap to padding (transitioning to contained)
        if (Math.abs(newWidth - maxWidth) < snapThreshold) {
          newWidth = maxWidth;
          newObjectFit = "contain";
        } else if (newWidth < maxWidth - snapThreshold) {
          // Definitely in contain mode
          newObjectFit = "contain";
        } else if (newWidth > maxWidth) {
          // If width exceeds document width (maxWidth), stay in cover mode
          newWidth = "full";
          newObjectFit = "cover";
        } else if (newWidth >= viewport.width - 10) {
          // Snap back to full if close
          newWidth = "full";
          newObjectFit = "cover";
        }
      } else {
        // Already in custom width mode
        newWidth = Math.max(
          constraintMinWidth,
          Math.min(viewport.width, (startWidth as number) + widthDelta),
        );

        // Check if we should snap back to full width
        if (newWidth >= viewport.width - snapThreshold) {
          newWidth = "full";
          newObjectFit = "cover";
        } else if (
          newWidth >= maxWidth - snapThreshold &&
          newWidth <= maxWidth + snapThreshold
        ) {
          // Snap to padding width
          newWidth = maxWidth;
          newObjectFit = "contain";
        } else if (newWidth > maxWidth) {
          // If width exceeds document width (maxWidth), convert to cover
          newWidth = "full";
          newObjectFit = "cover";
        } else {
          // Remain in contain mode
          newObjectFit = "contain";
        }
      }

      // In contain mode, calculate height based on image aspect ratio to avoid jumps
      // Apply minWidth constraint to prevent over-resizing of wide images
      if (
        newObjectFit === "contain" &&
        typeof newWidth === "number" &&
        block.url
      ) {
        const cachedImage = imageCache.get(block.url);
        if (cachedImage && cachedImage.complete) {
          const imgAspectRatio =
            cachedImage.naturalWidth / cachedImage.naturalHeight;

          // Ensure width doesn't go below minimum (already enforced above, but keep for clarity)
          newWidth = Math.max(newWidth, constraintMinWidth);

          // Calculate height based on width and aspect ratio
          newHeight = newWidth / imgAspectRatio;
        }
      }
    } else if (handle === "bottom" && startObjectFit === "cover") {
      // Vertical resize (only in cover mode)
      // In cover mode, we enforce minimum height
      const { minHeight: constraintMinHeight } = styles.imageResize.constraints;
      const calculatedHeight = Math.max(
        constraintMinHeight,
        startHeight + deltaY,
      );

      // Cap height based on image aspect ratio to prevent over-resizing
      if (block.url) {
        const cachedImage = imageCache.get(block.url);
        if (cachedImage && cachedImage.complete) {
          const imgAspectRatio =
            cachedImage.naturalWidth / cachedImage.naturalHeight;

          // Calculate the current container width
          const containerWidth =
            typeof startWidth === "number" ? startWidth : viewport.width;

          // For portrait images (tall), cap the height so it doesn't exceed the image's natural ratio
          // This prevents excessive cropping when the image is resized too tall
          const maxHeightForRatio = containerWidth / imgAspectRatio;

          // Cap the height at the image's natural ratio relative to container width
          newHeight = Math.min(calculatedHeight, maxHeightForRatio);

          // Ensure we don't go below minimum height
          newHeight = Math.max(newHeight, constraintMinHeight);
        } else {
          newHeight = calculatedHeight;
        }
      } else {
        newHeight = calculatedHeight;
      }
    }

    // Update the block with new dimensions
    const updatedBlock: Block = {
      ...block,
      width: newWidth,
      height: newHeight,
      objectFit: newObjectFit,
    };

    // Invalidate the block height cache since dimensions changed
    invalidateBlockCache(updatedBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = updatedBlock;

    return {
      state: {
        ...state,
        document: {
          ...state.document,
          page: { ...state.document.page, blocks: newBlocks },
        },
      },
      ops: [],
    };
  },
);

/**
 * Finish an image-resize drag: clear the resize-handle highlight and emit a
 * `block_set` op for each dimension (width / height / objectFit) that actually
 * changed since the drag began (the start values come from the captured hit via
 * the payload).
 *
 * The `!== undefined` guards are load-bearing — a defensive resize-math edge
 * case could leave a dimension unset, and emitting `value: undefined`
 * serializes to a value-less `block_set` that `applyBlockSet`/`validateField`
 * reject on every peer, silently desyncing the local image. They are preserved
 * exactly (see `__fuzz__/image-resize-undefined.test.ts`).
 */
export const END_IMAGE_HANDLE_DRAG = stateAction<{
  blockIndex: number;
  startWidth: number | "full";
  startHeight: number;
  startObjectFit: "cover" | "contain";
}>(
  "end-image-handle-drag",
  (state, { blockIndex, startWidth, startHeight, startObjectFit }) => {
    const ops: Operation[] = [];
    const block = state.document.page.blocks[blockIndex];

    if (block && block.type === "image") {
      const blockId = block.id;

      // Create operations only for fields that changed during the drag.
      // Compare final values with original values from when drag started.
      // Guard against `undefined`: a defensive resize math edge case could leave
      // a dimension unset, and emitting `value: undefined` serializes to a
      // value-less block_set that `applyBlockSet`/`validateField` reject on every
      // peer — leaving the local editor's image silently desynced (it reflows to
      // its default size, jumping the content below it). Never emit such an op.
      if (block.width !== startWidth && block.width !== undefined) {
        ops.push({
          op: "block_set",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          blockId,
          field: "width",
          value: block.width,
        });
      }

      if (block.height !== startHeight && block.height !== undefined) {
        ops.push({
          op: "block_set",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          blockId,
          field: "height",
          value: block.height,
        });
      }

      if (block.objectFit !== startObjectFit && block.objectFit !== undefined) {
        ops.push({
          op: "block_set",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          blockId,
          field: "objectFit",
          value: block.objectFit,
        });
      }
    }

    const blockId = state.document.page.blocks[blockIndex]?.id;
    return {
      state: blockId ? setImageResizeHandle(state, blockId, null) : state,
      ops,
    };
  },
);

/**
 * Cancel an image-resize drag (e.g. pointer cancel) without recording undo:
 * clear the resize-handle highlight and emit no ops. The in-progress dimension
 * changes {@link UPDATE_IMAGE_HANDLE_DRAG} wrote stay on the block but were
 * never committed as ops, mirroring the previous behavior.
 */
export const CANCEL_IMAGE_HANDLE_DRAG = stateAction<{ blockIndex: number }>(
  "cancel-image-handle-drag",
  (state, { blockIndex }) => {
    const blockId = state.document.page.blocks[blockIndex]?.id;
    return {
      state: blockId ? setImageResizeHandle(state, blockId, null) : state,
      ops: [],
    };
  },
);

/**
 * Set or clear the image hover overlay (the resize-handle chrome). The handler
 * passes the resolved {@link ImageHoverState} (or `null` to clear). Pure, no ops.
 */
export const SET_IMAGE_HOVER = stateAction<{
  imageHover: ImageHoverState | null;
}>("set-image-hover", (state, { imageHover }) => {
  if (imageHover === null) {
    if (state.ui.imageHover === null) return { state, ops: [] };
    return {
      state: { ...state, ui: { ...state.ui, imageHover: null } },
      ops: [],
    };
  }
  return { state: { ...state, ui: { ...state.ui, imageHover } }, ops: [] };
});

/**
 * Tap below a trailing image block: append a new empty paragraph after it and
 * place the caret in it. This is a touch-driven document mutation, so it emits a
 * single `block_insert`. The handler supplies the `afterBlock` (the trailing
 * image), its index, and the per-instance {@link CRDTbinding} used to mint the
 * new block + op ids.
 */
export const CREATE_PARAGRAPH_BELOW_IMAGE = stateAction<{
  afterBlock: Block;
  afterBlockIndex: number;
  binding: CRDTbinding;
}>(
  "create-paragraph-below-image",
  (state, { afterBlock, afterBlockIndex, binding }) => {
    const newParagraphId = binding.nextId();
    const newParagraph: Block = {
      id: newParagraphId,
      afterId: afterBlock.id,
      type: "paragraph",
      charRuns: [],
      formats: [],
    };

    const blockInsertOp: Operation = {
      op: "block_insert",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: binding.pageId,
      afterBlockId: afterBlock.id,
      blockId: newParagraphId,
      blockType: "paragraph",
    };

    const newBlocks = [...state.document.page.blocks, newParagraph];
    const newPage = { ...state.document.page, blocks: newBlocks };

    let next = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    next = clearSelection(next);
    next = moveCursorToPosition(next, afterBlockIndex + 1, 0);
    next = updateMode(next, "edit");

    return { state: next, ops: [blockInsertOp] };
  },
);

// ─── Image-handle-drag wrappers (formerly events/eventUtils.ts) ──────────────
//
// Thin functions the event/region layer calls: they resolve pointer + geometry
// data (which handle was grabbed, the start dimensions) and dispatch the actions
// above via `state.actionBus.dispatchState(...)`. They live with the node so the
// resize-handle drag logic is co-located with the image block.

/**
 * Start an image drag resize operation. Returns the updated state plus the
 * resolved `start` descriptor (which the caller stashes on the captured hit), or
 * `null` if no drag handle was hit. `extraTolerance` widens the hit area (mouse
 * vs touch).
 */
export function startImageHandleDrag(
  state: EditorState,
  imageBlock: {
    blockIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
  },
  canvasX: number,
  canvasY: number,
  extraTolerance: number = 4,
): { state: EditorState; start: ImageDragStart } | null {
  const block = state.document.page.blocks[imageBlock.blockIndex];
  if (!block || block.deleted) return null;
  if (block.type !== "image") {
    return null;
  }

  const objectFit = block.objectFit ?? "cover";
  const clickedHandle = getDragHandleAtPoint(
    canvasX,
    canvasY,
    imageBlock.x,
    imageBlock.y,
    imageBlock.width,
    imageBlock.height,
    objectFit,
    extraTolerance,
  );

  if (clickedHandle && block.url) {
    // Use the displayed dimensions (imageBlock.width/height) instead of stored
    // dimensions (block.width/height) so resizing works correctly on mobile when
    // the image was resized on desktop. For 'full' width images, keep 'full'.
    const storedWidth = block.width ?? "full";
    const startWidth = storedWidth === "full" ? "full" : imageBlock.width;
    const startHeight = imageBlock.height;

    const start: ImageDragStart = {
      handle: clickedHandle,
      startX: canvasX,
      startY: canvasY,
      startWidth,
      startHeight,
      startObjectFit: objectFit,
    };
    // Record the render-visible handle highlight; the start descriptor itself
    // rides on the captured hit (returned to the caller).
    const next = state.actionBus.dispatchState(START_IMAGE_HANDLE_DRAG, state, {
      blockIndex: imageBlock.blockIndex,
      handle: clickedHandle,
    }).state;
    return { state: next, start };
  }

  return null;
}

/** Update image dimensions during a drag resize. `start` is the drag's start
 *  descriptor (from the captured hit). */
export function updateImageHandleDrag(
  state: EditorState,
  viewport: ViewportState,
  canvasX: number,
  canvasY: number,
  blockIndex: number,
  start: ImageDragStart,
): EditorState {
  return state.actionBus.dispatchState(UPDATE_IMAGE_HANDLE_DRAG, state, {
    viewport,
    canvasX,
    canvasY,
    blockIndex,
    ...start,
  }).state;
}

/**
 * End an image drag resize operation, returning the `{ state, ops }` with the
 * `block_set` ops for the dimensions that changed. `start` (from the captured
 * hit) supplies the pre-drag dimensions to diff against.
 */
export function endImageHandleDrag(
  state: EditorState,
  blockIndex: number,
  start: ImageDragStart,
): {
  state: EditorState;
  ops: Operation[];
} {
  return state.actionBus.dispatchState(END_IMAGE_HANDLE_DRAG, state, {
    blockIndex,
    startWidth: start.startWidth,
    startHeight: start.startHeight,
    startObjectFit: start.startObjectFit,
  });
}

/** Cancel an image drag resize operation (without recording undo). */
export function cancelImageHandleDrag(
  state: EditorState,
  blockIndex: number,
): EditorState {
  return state.actionBus.dispatchState(CANCEL_IMAGE_HANDLE_DRAG, state, {
    blockIndex,
  }).state;
}
