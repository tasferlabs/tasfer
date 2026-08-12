/**
 * ImageNode — the `image` block ported onto AtomicNode.
 *
 * What the port demonstrates beyond LineNode:
 *  - Non-trivial geometry (centering, full-width bleed, drawn rect ≠ flow box),
 *    computed ONCE in `geometry()` and shared by the height pass and paint —
 *    the layout/paint split removes the duplication that previously existed
 *    between renderImageBlock and the height pass.
 *  - `paintBox()` override: the painted/selected rect differs from the flow box.
 *    A first full-width image bleeds into the top padding (drawn higher than its
 *    flow origin), which relocates that padding to a strip *below* the image —
 *    hosts reserve it for page chrome such as a tag row under a cover image
 *    (see {@link imageBleedHeight}).
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

import { type ActionBus, DRAG_DETENT, stateAction } from "../action-bus";
import { CLEAR_SELECTION, SPLIT_BLOCK } from "../actions/edit-actions";
import {
  EXTEND_SELECTION_DOWN,
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_RIGHT,
  EXTEND_SELECTION_UP,
  MOVE_CURSOR_DOWN,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_RIGHT,
  MOVE_CURSOR_UP,
} from "../actions/keyboard-actions";
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
import {
  clearSelection,
  getVisualBlockSelectionIndex,
  moveCursorToPosition,
} from "../selection";
import { escapeAttr } from "../serlization/codecs/inline";
import type { NodeCodec } from "../serlization/codecs/types";
import type { Block } from "../serlization/loadPage";
import {
  IMAGE_ALT_END,
  IMAGE_END,
  IMAGE_START,
  NEWLINE,
  TEXT,
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
import { findBlockIndex } from "../sync/block-lookup";
import { orderKeyAfter } from "../sync/crdt-utils";
import { applyOps } from "../sync/reducer";

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
  /**
   * Which part of a cropped image the frame shows, as CSS `object-position`
   * fractions: `{x: 0, y: 0}` pins the crop to the top-left of the source,
   * `{x: 1, y: 1}` to the bottom-right. Absent means centered (`0.5/0.5`), the
   * behavior every image had before repositioning existed.
   *
   * Stored normalized, not in pixels, because the crop must survive the things
   * that change the frame without changing intent: a bottom-handle resize, a
   * narrower viewport (see `geometry`'s proportional-height branch), and a peer
   * rendering the same block at a different width. Only meaningful in `cover`
   * mode — `contain` crops nothing.
   */
  objectPosition?: { x: number; y: number };
}

/** A cover image's default crop origin: centered on both axes. */
export const DEFAULT_OBJECT_POSITION = { x: 0.5, y: 0.5 } as const;

/** Clamp a raw object-position fraction into the valid `[0, 1]` range. */
function clampFraction(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * A block's effective crop origin. Falls back to centered, and clamps stored
 * values defensively — a peer on an older build (or a hand-edited op) can put
 * anything on the block, and an out-of-range fraction would drag the drawn
 * source rect off the decoded image and blank the frame.
 */
export function imageObjectPosition(block: Image): { x: number; y: number } {
  const raw = block.objectPosition;
  if (!raw) return DEFAULT_OBJECT_POSITION;
  return { x: clampFraction(raw.x), y: clampFraction(raw.y) };
}

/**
 * Format a crop origin as a CSS `object-position` value (`"40% 20%"`), the form
 * both the exported stylesheet and the `data-object-position` round-trip use.
 * Percentages are rounded to two decimals — finer than any drag can express,
 * and enough that a round-trip never visibly moves the image.
 */
function formatObjectPosition(position: { x: number; y: number }): string {
  const pct = (n: number): string => `${Number((n * 100).toFixed(2))}%`;
  return `${pct(position.x)} ${pct(position.y)}`;
}

/**
 * Parse a `"40% 20%"` object-position back into fractions. Returns undefined for
 * anything else — a foreign `<img>` may carry keyword forms (`center`, `top
 * left`) or units we don't store, and dropping to the centered default is the
 * safe read.
 */
function parseObjectPosition(
  raw: string | undefined,
): { x: number; y: number } | undefined {
  if (!raw) return undefined;
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 2) return undefined;
  const values = parts.map((part) => {
    if (!part.endsWith("%")) return Number.NaN;
    return Number.parseFloat(part) / 100;
  });
  if (values.some((v) => !Number.isFinite(v))) return undefined;
  return { x: clampFraction(values[0]), y: clampFraction(values[1]) };
}

/**
 * How much of the source a `cover` crop hides on each axis, in *source* pixels
 * — the room a reposition drag has to move. Exactly one axis is normally
 * non-zero: the crop matches the frame on the other. Zero on both means the
 * aspect ratios agree and there is nothing to reposition.
 */
export function imageCropSlack(
  img: HTMLImageElement,
  frameWidth: number,
  frameHeight: number,
): { x: number; y: number } {
  if (frameWidth <= 0 || frameHeight <= 0) return { x: 0, y: 0 };
  const imgAspect = img.naturalWidth / img.naturalHeight;
  const frameAspect = frameWidth / frameHeight;
  if (imgAspect > frameAspect) {
    // Source is wider than the frame: it is cropped horizontally.
    return { x: img.naturalWidth - img.naturalHeight * frameAspect, y: 0 };
  }
  return { x: 0, y: img.naturalHeight - img.naturalWidth / frameAspect };
}

/** Whether a block has any room to reposition — the gate for offering the
 *  affordance at all. A crop whose aspect matches its frame hides nothing, and
 *  a "Reposition" button that cannot move anything is a lie. */
export function canRepositionImage(
  block: Image,
  frameWidth: number,
  frameHeight: number,
): boolean {
  if ((block.objectFit ?? "cover") !== "cover" || !block.url) return false;
  const img = imageCache.get(block.url);
  if (!img?.complete || img.naturalWidth === 0) return false;
  const slack = imageCropSlack(img, frameWidth, frameHeight);
  // Sub-pixel slack is not worth a drag: it cannot move the image visibly.
  return slack.x > 1 || slack.y > 1;
}

/**
 * Translate a pointer delta (canvas px) into a new crop position, clamped to the
 * image edges. The drag moves the IMAGE with the pointer, so the crop window
 * travels the opposite way — hence the negated deltas.
 *
 * An axis with no slack is pinned: the drag simply does nothing there rather
 * than accumulating an offset the clamp would swallow.
 */
export function repositionFromDelta(
  img: HTMLImageElement,
  frameWidth: number,
  frameHeight: number,
  start: { x: number; y: number },
  deltaX: number,
  deltaY: number,
): { x: number; y: number } {
  const slack = imageCropSlack(img, frameWidth, frameHeight);
  // Source pixels per canvas pixel: in `cover` the image is scaled up until it
  // covers both axes, so the smaller ratio is the one in effect.
  const sourcePerCanvas = Math.min(
    img.naturalWidth / frameWidth,
    img.naturalHeight / frameHeight,
  );
  return {
    x:
      slack.x > 0
        ? clampFraction(start.x - (deltaX * sourcePerCanvas) / slack.x)
        : start.x,
    y:
      slack.y > 0
        ? clampFraction(start.y - (deltaY * sourcePerCanvas) / slack.y)
        : start.y,
  };
}

// ── Image asset cache ──────────────────────────────────────────────────────
// Co-located with the image block: this is image-only state. Shared as module
// singletons because one decode must serve every image block (and the event /
// export layers, which import `imageCache` via renderer's re-export).

/** Decoded images, keyed by url/asset-hash. */
export const imageCache = new Map<string, HTMLImageElement>();

/** A parked load failure: when it last failed and how many attempts it took. */
interface FailedLoad {
  /** Timestamp (epoch ms) of the most recent failure. */
  at: number;
  /** Automatic attempts already spent on this url. */
  attempts: number;
}
/**
 * Urls that failed to load — avoids hammering a broken source on every repaint.
 * Failures are not permanent: an entry older than {@link FAILED_TTL_MS} is
 * re-attempted by {@link loadImage}, and {@link clearFailedImageCache} (manual
 * retry, or the host's `online` handler) drops entries outright.
 */
const failedImageCache = new Map<string, FailedLoad>();
/** In-flight loads, so concurrent blocks dedupe onto one decode. */
const pendingLoads = new Map<string, Promise<HTMLImageElement>>();

/** Automatic load attempts (including the first) before a url is parked. */
const MAX_LOAD_ATTEMPTS = 3;
/** Backoff before the first retry; doubles on each subsequent attempt. */
const RETRY_BASE_DELAY_MS = 500;
/** How long a parked failure stays sticky before a repaint may retry it. */
const FAILED_TTL_MS = 30_000;

/** Clear a failed url (or all) so a retry can re-attempt the load. */
export function clearFailedImageCache(url?: string): void {
  if (url) {
    failedImageCache.delete(url);
  } else {
    failedImageCache.clear();
  }
}

/**
 * Whether `url` is currently parked as failed. An entry past its TTL is dropped
 * here so the next {@link loadImage} re-attempts it — the render path then shows
 * "loading" and retries instead of staying stuck on the error state.
 */
function isImageFailed(url: string): boolean {
  const failed = failedImageCache.get(url);
  if (!failed) return false;
  if (Date.now() - failed.at >= FAILED_TTL_MS) {
    failedImageCache.delete(url);
    return false;
  }
  return true;
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
  const failed = failedImageCache.get(url);
  if (failed) {
    if (Date.now() - failed.at < FAILED_TTL_MS) {
      return Promise.reject(
        new Error(`Image previously failed to load: ${url}`),
      );
    }
    // TTL elapsed — drop the parked failure and re-attempt from scratch.
    failedImageCache.delete(url);
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

    // Bounded retry with exponential backoff: a transient failure (offline, a
    // flaky source, or an asset not yet synced from a peer) gets a few automatic
    // attempts before the url is parked as failed.
    for (let attempt = 1; ; attempt++) {
      try {
        const img = await decodeImage(resolvedUrl, isAlreadyUrl);
        imageCache.set(url, img);
        pendingLoads.delete(url);
        return img;
      } catch (error) {
        if (attempt >= MAX_LOAD_ATTEMPTS) {
          failedImageCache.set(url, { at: Date.now(), attempts: attempt });
          pendingLoads.delete(url);
          throw error instanceof Error
            ? error
            : new Error(`Failed to load image: ${url}`);
        }
        await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  })();

  pendingLoads.set(url, promise);
  return promise;
}

/**
 * Decode one image url into an `HTMLImageElement` — resolves on load, rejects on
 * error. `crossOrigin` is set for already-loadable urls (parity with the prior
 * inline loader) so canvas export stays untainted.
 */
function decodeImage(
  src: string,
  crossOrigin: boolean,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
    // Already complete from the browser cache — resolve immediately.
    if (img.complete) {
      resolve(img);
    }
  });
}

/** Promise-based delay used to back off between automatic load retries. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ImageGeometry {
  readonly displayX: number;
  readonly displayWidth: number;
  /** Drawn image height, excluding the trailing flow padding. */
  readonly displayHeight: number;
}

/**
 * Effective length of a resize bar. The configured `length` is the target, but
 * on a small image a fixed-length bar overflows the image edges — a 100px
 * vertical bar centered on a 40px-tall image spills ~30px past the top and
 * bottom. Clamp the bar to the image's extent along its axis, keeping an 8px
 * margin at each end while space allows, so it always reads as a handle sitting
 * inside the image. Both the renderer and the hit-tester route through this so
 * the drawn bar and its hit area never disagree.
 */
function fitBarLength(configured: number, extent: number): number {
  const END_MARGIN = 8;
  return Math.max(0, Math.min(configured, extent - END_MARGIN * 2));
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
  styles: EditorStyles,
  objectFit: "cover" | "contain" = "cover",
  extraTolerance: number = 4,
): "left" | "right" | "bottom" | null {
  // Hit-test geometry must match the painted handles, which use the instance's
  // resolved styles (`drawDragHandles` → `c.styles`). A host can widen
  // `imageResize.dragHandles.*.inset` per instance (e.g. to clear a touch
  // scrollbar target or the platform edge-gesture zone), so the caller passes
  // the same per-instance styles rather than re-resolving defaults here.
  const { vertical, horizontal } = styles.imageResize.dragHandles;

  // Extra tolerance for easier hovering/tapping (pixels beyond the visible bar)
  const tolerance = extraTolerance;

  // Bar lengths are clamped to the image so a small image's handles don't
  // overflow its edges (see fitBarLength); the render path clamps identically.
  const verticalLength = fitBarLength(vertical.length, imageHeight);
  const horizontalLength = fitBarLength(horizontal.length, imageWidth);

  // Left vertical bar (centered vertically with specified length)
  const leftBarX = imageX + vertical.inset;
  const leftBarWidth = vertical.thickness;
  const leftBarY = imageY + (imageHeight - verticalLength) / 2; // Center vertically
  const leftBarHeight = verticalLength;

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
  const rightBarY = imageY + (imageHeight - verticalLength) / 2; // Center vertically
  const rightBarHeight = verticalLength;

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
    const bottomBarX = imageX + (imageWidth - horizontalLength) / 2; // Center horizontally
    const bottomBarWidth = horizontalLength;
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
 * default height, centered crop) and thus losslessly representable as
 * `![alt](url)`. Serialization policy — lives with the node.
 */
export function isImageDefault(block: Image): boolean {
  const width = block.width ?? "full";
  const height = block.height ?? IMAGE_DEFAULT_HEIGHT;
  const objectFit = block.objectFit ?? "cover";
  const position = imageObjectPosition(block);

  return (
    width === "full" &&
    height === IMAGE_DEFAULT_HEIGHT &&
    objectFit === "cover" &&
    position.x === DEFAULT_OBJECT_POSITION.x &&
    position.y === DEFAULT_OBJECT_POSITION.y
  );
}

/**
 * The image's resolved width *mode*, the single source of truth for what an
 * unset `width` means. An explicit number is a user-sized, contained width.
 * With no stored width the mode depends on fit: a `contain` image (e.g. one
 * pasted in) is "natural" — fit within the content column at its decoded size,
 * never edge-to-edge — while the legacy `cover` default is "full", bleeding to
 * the viewport edges. Every layout, hit-test, and serialization site routes
 * through this so they can't disagree on the default.
 */
function imageWidthMode(block: Image): number | "full" | "natural" {
  if (typeof block.width === "number") return block.width;
  return (block.objectFit ?? "cover") === "contain" ? "natural" : "full";
}

/**
 * The drawn height of a full-width image assuming it is the document's first
 * visible block — the "cover image" case, where the image bleeds into the top
 * canvas padding and is drawn from document y = 0 (so this is also its bottom
 * edge in document coordinates). `null` when the block wouldn't bleed (an
 * explicitly sized or natural-fit image). The height mirrors `geometry()`'s
 * full-width branch: the stored height (or themed default) once a url exists,
 * the placeholder height before one does.
 *
 * Exported for the first-party host, which lays page chrome (the tag row)
 * directly below a cover image; routing through this keeps the host and the
 * node's own layout in agreement. Takes the image's visual props — either the
 * block itself or the plain-data `attrs` of a `BlockData` whose `type` is
 * `"image"` (the read API's attrs are untyped, hence the record overload).
 */
export function imageBleedHeight(
  block:
    | Pick<Image, "url" | "width" | "height" | "objectFit">
    | Readonly<Record<string, unknown>>,
  styles: EditorStyles,
): number | null {
  const image = block as Image;
  if (imageWidthMode(image) !== "full") return null;
  const { height, placeholderHeight } = styles.blocks.image.dimensions;
  return image.url ? (image.height ?? height) : placeholderHeight;
}

/**
 * The image's drawn rect (size + inline offset) for a given content-column
 * width. The single geometry source: the node's own layout, height, and paint
 * passes all route through it, and so does the host-facing
 * {@link canRepositionImageAt}, so no surface can disagree about how large the
 * image draws.
 */
function imageGeometry(
  block: Image,
  maxWidth: number,
  styles: EditorStyles,
): ImageGeometry {
  const { height: defaultImageHeight, placeholderHeight } =
    styles.blocks.image.dimensions;

  const mode = imageWidthMode(block);
  const imageHeight = block.height ?? defaultImageHeight;

  if (mode === "full") {
    // Full width: edge-to-edge, ignoring page padding. Height via the shared
    // helper so the host-facing `imageBleedHeight` can't disagree with paint.
    return {
      displayX: 0,
      displayWidth:
        maxWidth + styles.canvas.paddingLeft + styles.canvas.paddingRight,
      displayHeight: imageBleedHeight(block, styles) ?? placeholderHeight,
    };
  }

  if (mode === "natural") {
    // Contained default (e.g. a pasted image): fit the decoded image within
    // the content column, centered, respecting page padding, with the height
    // following the natural aspect ratio. Until the image decodes, reserve
    // the full column width at placeholder height — the draw path invalidates
    // the cached layout and repaints once the natural size is known.
    const decoded = block.url ? imageCache.get(block.url) : undefined;
    if (block.url && decoded?.complete && decoded.naturalWidth > 0) {
      const aspect = decoded.naturalWidth / decoded.naturalHeight;
      const displayWidth = Math.min(decoded.naturalWidth, maxWidth);
      const displayX =
        styles.canvas.paddingLeft + (maxWidth - displayWidth) / 2;
      return { displayX, displayWidth, displayHeight: displayWidth / aspect };
    }
    return {
      displayX: styles.canvas.paddingLeft,
      displayWidth: maxWidth,
      displayHeight: placeholderHeight,
    };
  }

  // Custom width: respect padding, constrain to container, center.
  const requestedWidth = mode;
  const displayWidth = Math.min(requestedWidth, maxWidth);
  const displayX = styles.canvas.paddingLeft + (maxWidth - displayWidth) / 2;

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

/**
 * Whether an image has crop slack at the size it currently DRAWS at, resolved
 * without a paint context.
 *
 * The on-canvas chrome tests the box it already holds ({@link
 * canRepositionImage}); host chrome that owns no layout — the mobile toolbar,
 * which is where the mode is reachable at all on touch, since the on-canvas
 * affordance is revealed by hover — has only the block and the viewport. Both
 * resolve the frame through {@link imageGeometry}, so the two surfaces always
 * agree about whether the affordance is on offer.
 */
export function canRepositionImageAt(
  block:
    | Pick<Image, "url" | "width" | "height" | "objectFit">
    | Readonly<Record<string, unknown>>,
  viewport: ViewportState,
  styles: EditorStyles,
): boolean {
  const image = block as Image;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  const { displayWidth, displayHeight } = imageGeometry(
    image,
    maxWidth,
    styles,
  );
  return canRepositionImage(image, displayWidth, displayHeight);
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
 * Hit data for the reposition pan drag. `box` is the image's drawn rect, kept
 * for its dimensions only (the source↔canvas scale), so a viewport scroll
 * mid-drag doesn't invalidate it. `start` is filled in `onStart`.
 */
interface ImageRepositionHit {
  blockIndex: number;
  box: BlockBounds;
  start?: {
    pointerX: number;
    pointerY: number;
    position: { x: number; y: number };
  };
}

/**
 * The block currently in reposition mode, if any. Only one is ever in the mode
 * — {@link ENTER_IMAGE_REPOSITION} clears the others — so the keyboard handlers
 * can find their target without the caret being on the image (an atomic block
 * never holds the caret).
 */
function findRepositioningBlock(
  state: EditorState,
): { blockIndex: number; block: Image } | null {
  const blocks = state.document.page.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.deleted || block.type !== "image") continue;
    if (isRepositioning(state, block.id)) {
      return { blockIndex: i, block: block as Image };
    }
  }
  return null;
}

/**
 * Keyboard nudge step, as a fraction of the available slack rather than pixels:
 * the handlers run off the action bus with no layout context, and a fraction
 * behaves proportionally on every frame size. Shift takes the coarse step.
 */
const NUDGE_STEP = 0.01;
const NUDGE_STEP_COARSE = 0.1;

/** Move the repositioning block's crop by one keyboard step, locally like every
 *  other adjustment in the mode. Returns undefined when nothing is
 *  repositioning, passing the key through. */
function nudgeReposition(
  state: EditorState,
  axis: "x" | "y",
  direction: -1 | 1,
  coarse: boolean,
): { state: EditorState; ops: Operation[]; handled: true } | undefined {
  const target = findRepositioningBlock(state);
  if (!target) return undefined;

  const current = imageObjectPosition(target.block);
  const step = (coarse ? NUDGE_STEP_COARSE : NUDGE_STEP) * direction;
  const position = {
    ...current,
    [axis]: clampFraction(current[axis] + step),
  } as { x: number; y: number };

  // Claim the key even when the crop is already pinned at that edge: the arrow
  // belongs to the mode, and letting it fall through would move the caret
  // somewhere behind the image the user is still adjusting.
  if (position.x === current.x && position.y === current.y) {
    return { state, ops: [], handled: true };
  }

  const moved = state.actionBus.dispatchState(UPDATE_IMAGE_REPOSITION, state, {
    blockIndex: target.blockIndex,
    position,
  }).state;
  return { state: moved, ops: [], handled: true };
}

/** Leave reposition mode from the keyboard, if a block is in it. */
function exitRepositionFromKey(
  state: EditorState,
  revert: boolean,
): { state: EditorState; ops: Operation[]; handled: true } | undefined {
  const target = findRepositioningBlock(state);
  if (!target) return undefined;
  const result = state.actionBus.dispatchState(EXIT_IMAGE_REPOSITION, state, {
    blockIndex: target.blockIndex,
    revert,
  });
  return { state: result.state, ops: result.ops, handled: true };
}

/** Apply a reposition drag's current pointer position to the block, locally
 *  (the committing op comes from leaving the mode). */
function applyRepositionDrag(
  state: EditorState,
  hit: ImageRepositionHit,
  pointerX: number,
  pointerY: number,
): EditorState {
  const start = hit.start;
  if (!start) return state;
  const block = state.document.page.blocks[hit.blockIndex];
  if (!block || block.deleted || block.type !== "image") return state;
  const img = imageCache.get((block as Image).url);
  if (!img?.complete || img.naturalWidth === 0) return state;

  const position = repositionFromDelta(
    img,
    hit.box.width,
    hit.box.height,
    start.position,
    pointerX - start.pointerX,
    pointerY - start.pointerY,
  );
  return state.actionBus.dispatchState(UPDATE_IMAGE_REPOSITION, state, {
    blockIndex: hit.blockIndex,
    position,
  }).state;
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
  /**
   * Set while this block is in REPOSITION MODE — the opt-in state a cover enters
   * from its hover chrome, in which a drag over the image pans the crop instead
   * of scrolling the page. A mode (rather than a bare gesture) because a cover's
   * slack is almost always vertical, and a vertical drag on the document's first
   * block is the touch scroll gesture; stealing it would cost more than the
   * feature is worth.
   *
   * `origin` is the crop position when the mode was entered, kept so Cancel can
   * restore it — each drag inside the mode commits its own op (mirroring the
   * resize drag), so reverting is a new op, not a discarded buffer.
   */
  reposition?: { origin: { x: number; y: number } };
}

/**
 * Whether a block is currently in reposition mode. Hosts gate the mode's chrome
 * on this ALONE, never additionally on hover: the pointer routinely leaves the
 * image during the mode (a pan that drags past its edge, a reach for Done), and
 * a hover-gated Done/Cancel would vanish exactly then.
 */
export function isRepositioning(state: EditorState, blockId: string): boolean {
  return (
    (state.ui.nodeViewState[blockId] as ImageViewState | undefined)
      ?.reposition !== undefined
  );
}

/** Merge reposition mode into a block's `nodeViewState` slot (or clear it with
 *  `null`), preserving any host-set `uploadStatus` and resize highlight. */
function setImageReposition(
  state: EditorState,
  blockId: string,
  reposition: ImageViewState["reposition"] | null,
): EditorState {
  const prev = state.ui.nodeViewState[blockId] as ImageViewState | undefined;
  const next: ImageViewState = { ...prev };
  if (reposition === null) delete next.reposition;
  else next.reposition = reposition;
  return {
    ...state,
    ui: {
      ...state.ui,
      nodeViewState: { ...state.ui.nodeViewState, [blockId]: next },
    },
  };
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

/**
 * Classify an image's width as a resize detent. A free width is "free"; the two
 * snapped widths the resize math pins to — full-bleed ("full") and exactly the
 * content/padding width ("padding", where it flips to `contain`) — are the
 * milestones a drag should tap as it clicks into (or releases from) them. The
 * `UPDATE_IMAGE_HANDLE_DRAG` snap branches assign `maxWidth` exactly, so the
 * equality check is reliable, not a float near-miss.
 */
function imageResizeDetent(
  block: Image,
  maxWidth: number,
): "full" | "padding" | "free" {
  if (block.width === "full") return "full";
  if (typeof block.width === "number" && block.width === maxWidth) {
    return "padding";
  }
  return "free";
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
    return imageGeometry(c.block as Image, c.maxWidth, c.styles);
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
   * Whether this block draws as a cover: the document's first visible block in
   * full-width mode, bled up into the top canvas padding for an edge-to-edge
   * look. The flow origin is untouched — only the drawn rect starts higher —
   * so the top padding re-emerges as a strip *below* the image, which hosts
   * use for page chrome (see {@link imageBleedHeight}).
   */
  protected bleedsIntoTopPadding(c: NodeLayoutCtx): boolean {
    return c.isFirst && imageWidthMode(c.block as Image) === "full";
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
    const y = this.bleedsIntoTopPadding(c)
      ? c.origin.y - c.styles.canvas.paddingTop
      : c.origin.y;
    return { x: displayX, y, width: displayWidth, height: displayHeight };
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
      // The pan drag, live only while the block is in reposition mode. Capturing
      // the pointer here is what suppresses page scroll over the image on touch
      // — legitimate only because the user opted into the mode.
      hitRegion({
        id: "image-reposition",
        priority: 55,
        modes: ["edit", "select"],
        hitTest: (p): ImageRepositionHit | null => {
          const block = c.block as Image;
          if (!isRepositioning(c.state, block.id)) return null;
          const box = this.hitTestBox(c, c.origin, p);
          return box ? { blockIndex: c.blockIndex, box } : null;
        },
        drag: {
          onStart(h, p, ctx) {
            const block = ctx.state.document.page.blocks[h.blockIndex];
            if (!block || block.deleted || block.type !== "image") return null;
            h.start = {
              pointerX: p.x,
              pointerY: p.y,
              position: imageObjectPosition(block as Image),
            };
            return { state: withStoppedMomentum(ctx.state) };
          },
          onMove(p, ctx) {
            const h = ctx.session.captured?.hit as
              ImageRepositionHit | undefined;
            if (!h?.start) return { state: ctx.state };
            return { state: applyRepositionDrag(ctx.state, h, p.x, p.y) };
          },
          onEnd(p, ctx) {
            const h = ctx.session.captured?.hit as
              ImageRepositionHit | undefined;
            if (!h?.start) return { state: ctx.state };
            // A release with an unknown position (window-level mouseup) keeps
            // whatever the last move produced rather than snapping back. Still
            // no op: releasing the pointer is not confirming — the user may drag
            // again, and only leaving the mode saves the crop.
            return {
              state: p
                ? applyRepositionDrag(ctx.state, h, p.x, p.y)
                : ctx.state,
            };
          },
          onCancel(ctx) {
            const h = ctx.session.captured?.hit as
              ImageRepositionHit | undefined;
            if (!h?.start) return ctx.state;
            // Undo just this drag by restoring the position it began from — not
            // the position the mode was entered with, which Cancel owns. The
            // mode itself stays on.
            return ctx.state.actionBus.dispatchState(
              UPDATE_IMAGE_REPOSITION,
              ctx.state,
              { blockIndex: h.blockIndex, position: h.start.position },
            ).state;
          },
        },
      }),
      hitRegion({
        id: "image-resize",
        priority: 60,
        modes: ["edit", "select"],
        hitTest: (p, pointerType): ImageResizeHit | null => {
          // A readonly document is never resizable. `isReadonlyBase` persists
          // through `select` mode (which a readonly editor uses for
          // drag-selection), so gate on it rather than `mode === "readonly"`
          // to keep the resize drag inert there as well.
          if (c.state.ui.isReadonlyBase) return null;
          const block = c.block as Image;
          if (!block.url) return null;
          // Reposition mode owns the image body; resizing would fight the pan
          // for the same drag. Matches the chrome, which hides the bars too.
          if (isRepositioning(c.state, block.id)) return null;
          const box = this.hitTestBox(c, c.origin, p);
          if (!box) return null;
          const handle = getDragHandleAtPoint(
            p.x,
            p.y,
            box.x,
            box.y,
            box.width,
            box.height,
            getEditorStyles(c.state),
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

            const nextState = updateImageHandleDrag(
              state,
              viewport,
              p.x,
              p.y,
              h.blockIndex,
              h.start,
            );

            // Tap when the resize snaps into (or releases from) a width detent —
            // full-bleed or padding-width — so the gesture has tactile feedback
            // during the drag, mirroring the caret's boundary tap. Free dragging
            // between detents stays silent.
            const nextBlock = nextState.document.page.blocks[h.blockIndex];
            if (nextBlock?.type === "image") {
              const styles = getEditorStyles(state);
              const maxWidth =
                viewport.width -
                (styles.canvas.paddingLeft + styles.canvas.paddingRight);
              if (
                imageResizeDetent(block, maxWidth) !==
                imageResizeDetent(nextBlock, maxWidth)
              ) {
                state.actionBus.dispatch(DRAG_DETENT);
              }
            }

            return {
              state: withScrollbarInteraction(nextState),
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
          getEditorStyles(state),
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

    // Clicking away from the image being repositioned leaves the mode, keeping
    // the crop — direct manipulation reads as already applied, so discarding it
    // here would surprise. Deliberately does NOT claim the click: the user is
    // also trying to put their caret somewhere, and that should still happen.
    bus.registerState(
      TEXT_CLICK,
      (state, { position }) => {
        const target = findRepositioningBlock(state);
        if (!target || target.blockIndex === position.blockIndex) return;
        return state.actionBus.dispatchState(EXIT_IMAGE_REPOSITION, state, {
          blockIndex: target.blockIndex,
          revert: false,
        });
      },
      40,
    );

    // ── Reposition mode keyboard ─────────────────────────────────────────────
    //
    // While a cover is being repositioned the arrow keys nudge its crop and
    // Escape/Enter leave the mode, all claimed above the caret handlers. This is
    // what keeps the feature usable without a pointer — a drag-only reposition
    // would be unreachable from the keyboard entirely. Every handler returns
    // undefined when nothing is repositioning, so normal editing is untouched.
    const nudge =
      (axis: "x" | "y", direction: -1 | 1, coarse: boolean) =>
      (state: EditorState) =>
        nudgeReposition(state, axis, direction, coarse);

    bus.registerState(MOVE_CURSOR_LEFT, nudge("x", -1, false), 100);
    bus.registerState(MOVE_CURSOR_RIGHT, nudge("x", 1, false), 100);
    bus.registerState(MOVE_CURSOR_UP, nudge("y", -1, false), 100);
    bus.registerState(MOVE_CURSOR_DOWN, nudge("y", 1, false), 100);
    // Shift+Arrow arrives as the selection-extending actions; in this mode it is
    // the coarse step, the usual "shift means bigger increment" convention.
    bus.registerState(EXTEND_SELECTION_LEFT, nudge("x", -1, true), 100);
    bus.registerState(EXTEND_SELECTION_RIGHT, nudge("x", 1, true), 100);
    bus.registerState(EXTEND_SELECTION_UP, nudge("y", -1, true), 100);
    bus.registerState(EXTEND_SELECTION_DOWN, nudge("y", 1, true), 100);

    // Escape reverts to the crop the mode was entered with; Enter keeps it.
    bus.registerState(
      CLEAR_SELECTION,
      (state) => exitRepositionFromKey(state, true),
      100,
    );
    bus.registerState(
      SPLIT_BLOCK,
      (state) => exitRepositionFromKey(state, false),
      100,
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

    const boxY = this.bleedsIntoTopPadding(c)
      ? origin.y - c.styles.canvas.paddingTop
      : origin.y;
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
        { uploadStatus?: "uploading" | "error" } | undefined
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
        [{ text: this.str(state, "uploadFailed"), dy: 0 }],
        styles.blocks.image.error.textColor,
      );
    } else if (block.url) {
      if (isImageFailed(block.url)) {
        this.drawStatus(
          c,
          box,
          styles.blocks.image.error.backgroundColor,
          [{ text: this.str(state, "uploadFailed"), dy: 0 }],
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
    // Reposition mode owns the image: the resize bars would compete with a pan
    // drag for the same pixels, so they stand down until the mode is left. The
    // mode's own buttons are host overlay chrome, not painted here.
    if (!isRepositioning(c.state, (c.block as Image).id)) {
      this.drawDragHandles(c, box, objectFit);
    }
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
      // Crop the image to fill the container, offsetting the crop window by the
      // block's object-position (centered when unset — the historical behavior).
      const position = imageObjectPosition(c.block as Image);
      if (imgAspectRatio > containerAspectRatio) {
        sourceWidth = img.naturalHeight * containerAspectRatio;
        sourceX = (img.naturalWidth - sourceWidth) * position.x;
      } else {
        sourceHeight = img.naturalWidth / containerAspectRatio;
        sourceY = (img.naturalHeight - sourceHeight) * position.y;
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
    // A readonly document can't be resized, so never surface the resize chrome —
    // not on hover, selection, or an in-flight drag. Gate on `isReadonlyBase`
    // (not `mode === "readonly"`): a readonly editor can still enter `select`
    // mode for drag-selection, and the handles must stay hidden there too.
    if (state.ui.isReadonlyBase) return;
    // Handles are painted in three situations, in priority order:
    //  - mid-resize: the active handle lives in this block's transient view-state
    //    (`resizeHandle`) and is highlighted;
    //  - hover: the pointer is over the image (`ui.imageHover`), highlighting
    //    whichever handle it is near;
    //  - selected: the image is the current visual-block selection, so the
    //    handles show un-highlighted to tell the user where they can drag.
    // Hover is mouse-only and cleared when the pointer leaves the canvas; the
    // selected case is what surfaces handles on touch (and keeps them up while a
    // selected image is just sitting there) without depending on hover state.
    const draggingHandle = (
      state.ui.nodeViewState[block.id] as ImageViewState | undefined
    )?.resizeHandle;
    const isHovering =
      !!state.ui.imageHover && state.ui.imageHover.blockIndex === blockIndex;
    const isSelected = getVisualBlockSelectionIndex(state) === blockIndex;
    const shouldRender =
      (isHovering || !!draggingHandle || isSelected) && !!block.url;
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

  readonly codec: NodeCodec = {
    markdown: {
      tokens: [IMAGE_START],
      htmlTags: ["img"],
      output: (block, ctx) => {
        const b = block as Image;
        const alt = b.alt || "";
        const src = ctx.mapAssetUrl(b.url);

        // If image is in default state, use markdown syntax
        if (isImageDefault(b)) {
          return `![${alt}](${src})`;
        }

        // Otherwise, use an HTML tag with custom properties. Emit only the
        // dimensions that are actually set so an unset one round-trips as unset
        // (a pasted contain image carries neither width nor height — its size
        // is derived from the decoded image, not stored).
        const objectFit = b.objectFit ?? "cover";
        const attrs = [`src="${src}"`];
        if (alt) attrs.push(`alt="${alt}"`);
        if (b.width !== undefined) {
          attrs.push(
            b.width === "full" ? 'data-width="full"' : `width="${b.width}"`,
          );
        }
        if (b.height !== undefined) attrs.push(`height="${b.height}"`);
        attrs.push(`data-object-fit="${objectFit}"`);
        // Only a non-default crop is emitted, so an unrepositioned image keeps
        // the attribute set it had before repositioning existed.
        if (b.objectPosition !== undefined) {
          attrs.push(
            `data-object-position="${formatObjectPosition(imageObjectPosition(b))}"`,
          );
        }

        return `<img ${attrs.join(" ")} />`;
      },
      // ![alt](url)
      input: (ctx) => {
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
      },
      // <img src="url" alt="alt" width="..." height="..." data-object-fit="..." />
      inputTag: (tag, ctx) => {
        const { attrs } = tag;

        const widthRaw = attrs["width"] ?? attrs["data-width"];
        const width = widthRaw
          ? widthRaw === "full"
            ? ("full" as const)
            : parseInt(widthRaw, 10)
          : undefined;
        const height = attrs["height"]
          ? parseInt(attrs["height"], 10)
          : undefined;
        const objectFit = attrs["data-object-fit"]
          ? (attrs["data-object-fit"] as "cover" | "contain")
          : undefined;
        const objectPosition = parseObjectPosition(
          attrs["data-object-position"],
        );

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
          objectPosition,
        };
        return image;
      },
    },
    html: {
      output: (block, ctx) => {
        const b = block as Image;
        const src = ctx.mapAssetUrl(b.url);
        const alt = b.alt ? escapeAttr(b.alt) : "";
        const styles: string[] = ["display:block"];
        // Set on a full-width image so the document shell can bleed it out
        // over its side padding to the page edge (see the serializer's
        // `img.full-bleed`); the sizing that follows is the block's own.
        let className = "";

        // The frame must be given a definite height, otherwise `height:auto`
        // sizes the box to the source's own aspect ratio and both `object-fit`
        // and `object-position` become no-ops — a cropped cover then exports
        // (and prints to PDF) uncropped and off-position. Mirrors
        // `imageGeometry`: full width keeps the stored height verbatim, while a
        // user-sized image scales its height with the width when the page is
        // narrower than the image, which `aspect-ratio` expresses.
        const fit = b.objectFit ?? "cover";
        const mode = imageWidthMode(b);
        const height = b.height ?? IMAGE_DEFAULT_HEIGHT;

        if (mode === "natural") {
          // Contained default (a pasted image): the source's own size, capped
          // to the column — no crop to preserve, so no frame to impose.
          styles.push("max-width:100%", "height:auto", "margin:1em auto");
        } else {
          if (mode === "full") {
            className = ' class="full-bleed"';
            styles.push(`height:${Math.round(height)}px`);
          } else {
            styles.push(
              "max-width:100%",
              "margin:1em auto",
              `width:${Math.round(mode)}px`,
              `aspect-ratio:${Math.round(mode)}/${Math.round(height)}`,
              "height:auto",
            );
          }
          styles.push(`object-fit:${fit}`);
          if (fit === "cover") {
            styles.push(
              `object-position:${formatObjectPosition(imageObjectPosition(b))}`,
            );
          }
        }

        return `<img${className} src="${escapeAttr(src)}" alt="${alt}" style="${styles.join(";")}" />`;
      },
    },
    text: {
      output: (block) => (block as Image).alt || "",
    },
    assetRefs: (block) => {
      const url = (block as Image).url;
      return url ? [url] : [];
    },
  };
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

  // `bar` is the style set of the handle being drawn: the bottom bar is
  // configured separately from the side bars, so a host that styles one
  // differently (thicker touch grips, say) gets what it asked for.
  const renderBar = (
    bar: typeof vertical | typeof horizontal,
    barX: number,
    barY: number,
    barWidth: number,
    barHeight: number,
    isHovered: boolean,
  ): void => {
    ctx.save();
    ctx.globalAlpha = isHovered ? bar.hoverOpacity : bar.opacity;
    ctx.fillStyle = isHovered ? bar.hoverBackgroundColor : bar.backgroundColor;
    if (bar.borderRadius > 0) {
      ctx.beginPath();
      ctx.roundRect(barX, barY, barWidth, barHeight, bar.borderRadius);
      ctx.fill();
    } else {
      ctx.fillRect(barX, barY, barWidth, barHeight);
    }
    ctx.restore();
  };

  // Clamp bar lengths to the image so handles never overflow a small image's
  // edges; getDragHandleAtPoint clamps identically so hit areas match.
  const verticalLength = fitBarLength(vertical.length, height);
  const horizontalLength = fitBarLength(horizontal.length, width);

  // Left vertical bar
  renderBar(
    vertical,
    x + vertical.inset,
    y + (height - verticalLength) / 2,
    vertical.thickness,
    verticalLength,
    hoveredHandle === "left",
  );

  // Right vertical bar
  renderBar(
    vertical,
    x + width - vertical.inset - vertical.thickness,
    y + (height - verticalLength) / 2,
    vertical.thickness,
    verticalLength,
    hoveredHandle === "right",
  );

  // Bottom horizontal bar (cover mode only)
  if (showBottomHandle) {
    renderBar(
      horizontal,
      x + (width - horizontalLength) / 2,
      y + height - horizontal.inset - horizontal.thickness,
      horizontalLength,
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

// ── Reposition mode ──────────────────────────────────────────────────────────

/** Write a crop position onto an image block in place. Transient by itself —
 *  the caller decides whether to also emit the committing op. The block's
 *  layout does not depend on the crop, so no height-cache invalidation. */
function withObjectPosition(
  state: EditorState,
  blockIndex: number,
  position: { x: number; y: number },
): EditorState {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || block.type !== "image") return state;
  const blocks = [...state.document.page.blocks];
  blocks[blockIndex] = { ...block, objectPosition: position } as Block;
  return {
    ...state,
    document: {
      ...state.document,
      page: { ...state.document.page, blocks },
    },
  };
}

/** The `block_set` op committing a block's current crop position. */
function objectPositionOp(
  state: EditorState,
  blockId: string,
  position: { x: number; y: number },
): Operation {
  return {
    op: "block_set",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    blockId,
    field: "objectPosition",
    value: position,
  };
}

/**
 * The op committing a repositioning block's pending crop, or none if it never
 * left the position the mode was entered with.
 *
 * Every adjustment inside the mode — drag, key nudge — is local only, so this is
 * the SINGLE point where a reposition becomes an op: what peers receive and what
 * storage keeps. A half-finished pan is nobody else's business, and a live one
 * would otherwise flood peers with a position per pointer move.
 */
function repositionCommitOps(
  state: EditorState,
  blockIndex: number,
): Operation[] {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || block.type !== "image") return [];
  const view = state.ui.nodeViewState[block.id] as ImageViewState | undefined;
  const origin = view?.reposition?.origin;
  if (!origin) return [];
  const current = imageObjectPosition(block as Image);
  if (current.x === origin.x && current.y === origin.y) return [];
  return [objectPositionOp(state, block.id, current)];
}

/**
 * Enter reposition mode on an image, remembering the crop position at entry so
 * {@link EXIT_IMAGE_REPOSITION} can revert to it, and confirm to tell a real
 * move from a wash. Entering emits nothing of its own — the mode is local, never
 * shared with peers.
 */
export const ENTER_IMAGE_REPOSITION = stateAction<{ blockIndex?: number }>(
  "enter-image-reposition",
  (state, { blockIndex }) => {
    // Omitted index means "the selected image" — how host chrome addressed by
    // the current block rather than by a hit-tested rect (the mobile toolbar)
    // reaches the mode. The on-canvas affordance passes the index it hit.
    const index = blockIndex ?? state.document.selection?.focus.blockIndex;
    const block =
      index === undefined ? undefined : state.document.page.blocks[index];
    if (!block || block.deleted || block.type !== "image") {
      return { state, ops: [] };
    }
    // At most one block is ever in the mode: the keyboard handlers resolve their
    // target by scanning for it, and a second stuck one would shadow this.
    // Leaving it this way is the same "keep the crop" exit as clicking away, so
    // the block being displaced commits rather than losing its pending pan.
    let next = state;
    const ops: Operation[] = [];
    const previous = findRepositioningBlock(state);
    if (previous && previous.block.id !== block.id) {
      ops.push(...repositionCommitOps(next, previous.blockIndex));
      next = setImageReposition(next, previous.block.id, null);
    }
    return {
      state: setImageReposition(next, block.id, {
        origin: imageObjectPosition(block as Image),
      }),
      ops,
    };
  },
);

/**
 * Pan the crop while adjusting. Local only, for the WHOLE mode — not just one
 * drag: peers and storage see nothing until the user confirms via
 * {@link EXIT_IMAGE_REPOSITION}, so a session of dragging and nudging lands as
 * one op and one undo step rather than a stream of intermediate crops.
 */
export const UPDATE_IMAGE_REPOSITION = stateAction<{
  blockIndex: number;
  position: { x: number; y: number };
}>("update-image-reposition", (state, { blockIndex, position }) => ({
  state: withObjectPosition(state, blockIndex, position),
  ops: [],
}));

/**
 * Leave reposition mode, deciding what the whole session amounted to.
 *
 * Confirm (Done / Enter / clicking away) is where the crop is saved: one op for
 * the position the user settled on, or none if they ended up back where they
 * started. `revert` (Cancel / Escape) restores the entry position locally and
 * emits nothing — no peer ever saw the pan, so there is nothing to take back.
 */
export const EXIT_IMAGE_REPOSITION = stateAction<{
  blockIndex: number;
  revert: boolean;
}>("exit-image-reposition", (state, { blockIndex, revert }) => {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || block.type !== "image") {
    return { state, ops: [] };
  }
  if (!revert) {
    const ops = repositionCommitOps(state, blockIndex);
    return { state: setImageReposition(state, block.id, null), ops };
  }

  const view = state.ui.nodeViewState[block.id] as ImageViewState | undefined;
  const origin = view?.reposition?.origin;
  const cleared = setImageReposition(state, block.id, null);
  if (!origin) return { state: cleared, ops: [] };
  return { state: withObjectPosition(cleared, blockIndex, origin), ops: [] };
});

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
    const orderKey = orderKeyAfter(state.document.page.blocks, afterBlock.id);

    const blockInsertOp: Operation = {
      op: "block_insert",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: binding.pageId,
      orderKey,
      blockId: newParagraphId,
      blockType: "paragraph",
    };

    // Replay the op so the paragraph lands at its canonical sorted position
    // (appending + `afterBlockIndex + 1` only agrees when the image is the
    // literal last array element — trailing tombstones break both), then place
    // the caret by id.
    const newPage = applyOps(
      state.document.page,
      [blockInsertOp],
      state.schema,
    );

    let next = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    next = clearSelection(next);
    const paragraphIndex = findBlockIndex(newPage, newParagraphId);
    next = moveCursorToPosition(
      next,
      paragraphIndex !== -1 ? paragraphIndex : afterBlockIndex + 1,
      0,
    );
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
    getEditorStyles(state),
    objectFit,
    extraTolerance,
  );

  if (clickedHandle && block.url) {
    // Use the displayed dimensions (imageBlock.width/height) instead of stored
    // dimensions (block.width/height) so resizing works correctly on mobile when
    // the image was resized on desktop. Only a true edge-to-edge image keeps
    // 'full' — a contained/natural image starts from its rendered width.
    const startWidth =
      imageWidthMode(block) === "full" ? "full" : imageBlock.width;
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
