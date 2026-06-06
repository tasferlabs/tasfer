/**
 * ImageBlockView — the `image` block ported onto AtomicBlockView.
 *
 * What the port demonstrates beyond LineBlockView:
 *  - Non-trivial geometry (centering, full-width bleed, drawn rect ≠ flow box),
 *    computed ONCE in `geometry()` and shared by the height pass and paint —
 *    the layout/paint split removes the duplication that previously existed
 *    between renderImageBlock and calculateBlockHeight.
 *  - `paintBox()` override: the painted/selected rect differs from the flow box.
 *  - `adjustFlowHeight()`: a first full-width image bleeds into the top padding,
 *    so it advances the document by less than it draws.
 *  - Block-owned chrome (resize drag handles) drawn from UI state.
 *
 * Still out of scope (event layer): hit-testing the resize handles and driving
 * the drag lives in events/eventUtils + mouseEvents. Those would migrate onto
 * the optional BlockView.onPointerDown hook in a later pass.
 */

import { resolveAssetUrl } from "../../adapters";
import type { Image } from "../../serlization/loadPage";
import type { BlockBounds, EditorStyles } from "../../state-types";
import { AtomicBlockView } from "./AtomicBlockView";
import type { BlockLayoutCtx, BlockPaintCtx } from "./BlockView";

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

/** Load + cache an image. Resolves once decoded; the caller drives any redraw. */
function loadImage(url: string): Promise<HTMLImageElement> {
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
        resolvedUrl = await resolveAssetUrl(url);
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

export class ImageBlockView extends AtomicBlockView<Image> {
  readonly type = "image" as const;

  /**
   * Resolve the on-canvas geometry from block props + container width. Depends
   * only on layout context (no origin), so both the height pass and paint use it.
   */
  private geometry(c: BlockLayoutCtx): ImageGeometry {
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

  protected intrinsicHeight(c: BlockLayoutCtx): number {
    // Always add padding after image blocks for visual spacing.
    return (
      this.geometry(c).displayHeight +
      c.styles.blocks.image.dimensions.paddingBottom
    );
  }

  protected paintBox(c: BlockPaintCtx): BlockBounds {
    const { displayX, displayWidth, displayHeight } = this.geometry(c);
    const block = c.block as Image;
    const imageWidth = block.width ?? "full";

    // First full-width image bleeds up into the top padding for an edge-to-edge
    // look; it keeps its drawn dimensions but starts higher.
    const shouldBleed = c.isFirst && imageWidth === "full";
    const y = shouldBleed
      ? c.origin.y - c.styles.canvas.paddingTop
      : c.origin.y;

    return { x: displayX, y, width: displayWidth, height: displayHeight };
  }

  adjustFlowHeight(height: number, c: BlockLayoutCtx): number {
    const imageWidth = (c.block as Image).width ?? "full";
    if (c.isFirst && imageWidth === "full") {
      return height - c.styles.canvas.paddingTop;
    }
    return height;
  }

  protected draw(box: BlockBounds, c: BlockPaintCtx): void {
    const block = c.block as Image;
    const { ctx, state, styles, blockIndex } = c;
    const objectFit = block.objectFit ?? "cover";
    const { x, y, width, height } = box;

    // Upload status from transient UI state.
    const uploadStatus =
      state.ui.activeMenu.type === "imageUpload" &&
      state.ui.activeMenu.blockIndex === blockIndex
        ? state.ui.activeMenu.uploadStatus
        : undefined;

    if (uploadStatus === "uploading") {
      this.drawStatus(
        c,
        box,
        styles.blocks.image.uploading.backgroundColor,
        [{ text: styles.blocks.image.uploading.text, dy: 0 }],
        styles.blocks.image.uploading.textColor,
      );
    } else if (uploadStatus === "error") {
      this.drawStatus(
        c,
        box,
        styles.blocks.image.error.backgroundColor,
        [
          { text: styles.blocks.image.error.text, dy: 0 },
          { text: styles.blocks.image.error.retryText, dy: 20 },
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
            { text: styles.blocks.image.error.text, dy: 0 },
            { text: styles.blocks.image.error.retryText, dy: 20 },
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
            [{ text: styles.blocks.image.loading.text, dy: 0 }],
            styles.blocks.image.loading.textColor,
          );
          loadImage(block.url)
            .then(() => {
              // The decoded size may differ from the placeholder — drop the
              // cached height so it recomputes, then ask for a repaint.
              block.cachedHeight = undefined;
              block.cachedWidth = undefined;
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
        styles.blocks.image.placeholder.text,
        x + width / 2,
        y + height / 2,
      );
    }
  }

  protected drawChrome(box: BlockBounds, c: BlockPaintCtx): void {
    const objectFit = (c.block as Image).objectFit ?? "cover";
    this.drawDragHandles(c, box, objectFit);
  }

  private drawStatus(
    c: BlockPaintCtx,
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
    c: BlockPaintCtx,
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
    c: BlockPaintCtx,
    box: BlockBounds,
    objectFit: "cover" | "contain",
  ): void {
    const { state, blockIndex } = c;
    const block = c.block as Image;
    const shouldRender =
      ((state.ui.imageHover && state.ui.imageHover.blockIndex === blockIndex) ||
        (state.ui.imageDrag && state.ui.imageDrag.blockIndex === blockIndex)) &&
      !!block.url;
    if (!shouldRender) return;

    let hoveredHandle: "left" | "right" | "bottom" | null = null;
    if (state.ui.imageDrag && state.ui.imageDrag.blockIndex === blockIndex) {
      hoveredHandle = state.ui.imageDrag.handle;
    } else if (
      state.ui.imageHover &&
      state.ui.imageHover.blockIndex === blockIndex
    ) {
      hoveredHandle = state.ui.imageHover.hoveredHandle;
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
