/**
 * MathNode — the `math` (block-level LaTeX equation) block ported onto
 * AtomicNode.
 *
 * Like ImageNode, the on-canvas size depends on an async-decoded asset:
 * MathJax renders the LaTeX to an SVG which we rasterize to an ImageBitmap, and
 * the decoded height drives the block's flow height. So — exactly as with images
 * — when a render lands we drop the cached height and request a repaint, letting
 * the layout reflow to the real equation size. (The pre-port renderer.ts path
 * skipped that invalidation, leaving tall equations stuck at minHeight until an
 * unrelated edit happened to clear the cache.)
 *
 * The math render cache lives here as module singletons — one MathJax render
 * serves every block referencing the same equation — mirroring the image cache
 * co-located in ImageNode.
 *
 * Out of scope (event layer): click-to-edit hit-testing and hover tracking live
 * in events/mouseEvents + eventUtils, the same split used for image resize
 * handles. The shared selection-overlay machinery is inherited from
 * AtomicNode.
 *
 * The serialization methods are this node's markdown/HTML/text round-trip,
 * adapted into a BlockCodec by the schema. HTML output renders through
 * `ctx.renderMathSVG`, injected by the HTML orchestrator — the codec path must
 * NOT statically import `../math` (it boots MathJax at module load, and the
 * codec registry sits on the parser/fuzz import path). The on-canvas render
 * keeps the dynamic `import("../math")`.
 */

import { stateAction } from "../action-bus";
import { AtomicNode } from "../rendering/nodes/AtomicNode";
import type {
  BlockRuntimeState,
  NodeLayoutCtx,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import { escapeHtml } from "../serlization/codecs/inline";
import type { InputCtx, OutputCtx } from "../serlization/codecs/types";
import type { Block } from "../serlization/loadPage";
import {
  MATH_BLOCK,
  NEWLINE,
  type TokenType,
  type VisibleToken,
} from "../serlization/tokenizer";
import type { ActiveMenu, BlockBounds } from "../state-types";
import { setActiveMenu } from "../state-utils";

// Math block - rendered LaTeX equation. Named `MathBlock` (not `Math`) to avoid
// shadowing the global `Math` object, which this module uses heavily.
export interface MathBlock extends BlockRuntimeState {
  type: "math";
  latex: string;
  displayMode: boolean; // true = display/block mode, false = inline mode
}

// ── Math render cache ───────────────────────────────────────────────────────
// Rasterized equations keyed by displayMode + dpr + latex. Shared as module
// singletons because one MathJax render must serve every block referencing the
// same equation (mirrors the image cache in ImageNode).

interface RenderedMath {
  readonly img: HTMLImageElement | ImageBitmap;
  /** Logical (CSS-pixel) size of the rasterized equation. */
  readonly width: number;
  readonly height: number;
}

const mathImageCache = new Map<string, RenderedMath>();
const pendingMathRenders = new Set<string>();

function mathCacheKey(
  latex: string,
  displayMode: boolean,
  dpr: number,
  color: string,
): string {
  // `color` is part of the key so a theme change re-renders with the new text
  // color instead of serving the previous theme's colored glyphs.
  return `${displayMode ? "D" : "I"}:${dpr}:${color}:${latex}`;
}

/**
 * Render `latex` to an ImageBitmap via MathJax (lazy-imported) and cache it.
 * Returns nothing — the caller drives the repaint through `onReady` once the
 * decode completes.
 */
function renderMathToImage(
  latex: string,
  displayMode: boolean,
  color: string,
  errorBackgroundColor: string,
  onReady: () => void,
): void {
  const dpr = window.devicePixelRatio || 1;
  const cacheKey = mathCacheKey(latex, displayMode, dpr, color);
  if (mathImageCache.has(cacheKey) || pendingMathRenders.has(cacheKey)) return;

  pendingMathRenders.add(cacheKey);

  // Lazy import MathJax renderer
  import("../math").then(({ renderToSVG }) => {
    try {
      const svgString = renderToSVG(latex, displayMode);

      // Strip the mjx-container wrapper so we can manipulate the inner <svg>
      const coloredSvg = svgString.replace(
        /^<mjx-container[^>]*>([\s\S]*)<\/mjx-container>$/,
        "$1",
      );

      // Parse SVG to get its intrinsic dimensions
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(coloredSvg, "image/svg+xml");
      const svgEl = svgDoc.querySelector("svg");
      if (!svgEl) {
        pendingMathRenders.delete(cacheKey);
        return;
      }

      // Set fill color on the SVG root
      svgEl.setAttribute("color", color);
      svgEl.style.color = color;

      // Fix MathJax error background rects: they inherit fill="currentColor"
      // from the parent <g>, making error backgrounds the same color as text.
      // Set them to a semi-transparent color instead.
      for (const rect of svgEl.querySelectorAll("rect[data-background]")) {
        rect.setAttribute("fill", errorBackgroundColor);
      }

      // Scale up: MathJax uses ex units, we want ~20px font equivalent
      const scaleFactor = 2.2;
      const viewBox = svgEl.getAttribute("viewBox");
      const widthAttr = svgEl.getAttribute("width");
      const heightAttr = svgEl.getAttribute("height");

      // Logical (CSS-pixel) dimensions
      let w: number;
      let h: number;

      if (viewBox) {
        const parts = viewBox.split(/\s+/).map(Number);
        // viewBox is in MathJax internal units (1000 units per ex)
        w = Math.ceil((parts[2] / 1000) * 8.5 * scaleFactor) + 4;
        h = Math.ceil((parts[3] / 1000) * 8.5 * scaleFactor) + 4;
      } else {
        w = Math.ceil(parseFloat(widthAttr || "100") * scaleFactor);
        h = Math.ceil(parseFloat(heightAttr || "40") * scaleFactor);
      }

      // Physical-pixel dimensions for rasterization. Render at 2x the screen
      // DPR so glyph edges stay sharp even after downscale, and to compensate
      // for browsers that rasterize SVG <img> at lower-than-requested density.
      const renderScale = dpr * 2;
      const pxW = Math.max(1, Math.ceil(w * renderScale));
      const pxH = Math.max(1, Math.ceil(h * renderScale));

      // Set SVG natural size to integer physical pixels
      svgEl.setAttribute("width", String(pxW));
      svgEl.setAttribute("height", String(pxH));
      svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");

      const finalSvg = new XMLSerializer().serializeToString(svgEl);
      const svgBlob = new Blob([finalSvg], {
        type: "image/svg+xml;charset=utf-8",
      });
      const url = URL.createObjectURL(svgBlob);

      const img = new Image();
      img.decoding = "sync";
      img.width = pxW;
      img.height = pxH;
      const finalize = () => {
        const offscreen = document.createElement("canvas");
        offscreen.width = pxW;
        offscreen.height = pxH;
        const offCtx = offscreen.getContext("2d")!;
        offCtx.imageSmoothingEnabled = true;
        offCtx.imageSmoothingQuality = "high";
        offCtx.drawImage(img, 0, 0, pxW, pxH);
        URL.revokeObjectURL(url);

        createImageBitmap(offscreen)
          .then((bitmap) => {
            // Store both the physical-pixel bitmap and the logical CSS size
            mathImageCache.set(cacheKey, { img: bitmap, width: w, height: h });
            pendingMathRenders.delete(cacheKey);
            onReady();
          })
          .catch(() => {
            pendingMathRenders.delete(cacheKey);
          });
      };
      img.onload = finalize;
      img.onerror = () => {
        pendingMathRenders.delete(cacheKey);
        URL.revokeObjectURL(url);
      };
      img.src = url;
    } catch {
      pendingMathRenders.delete(cacheKey);
    }
  });
}

export class MathNode extends AtomicNode<MathBlock> {
  readonly type = "math" as const;

  /**
   * The math block's localized canvas strings, owned by the node rather than
   * the global string table. English defaults; localize per instance via
   * `theme.nodeStrings.math`. Read with `this.str`.
   */
  readonly strings = {
    clickToEdit: "Click to add equation",
    rendering: "Rendering...",
  } as const;

  // ── Rendering ──────────────────────────────────────────────────────────────

  /**
   * Drawn equation height, excluding the block's own top/bottom flow padding.
   * Falls back to minHeight until the equation has been rendered + cached.
   * Depends only on layout context, so the height pass and paint agree on size.
   */
  private contentHeight(c: NodeLayoutCtx): number {
    const block = c.block as MathBlock;
    const m = c.styles.blocks.math;
    if (block.latex) {
      const dpr = window.devicePixelRatio || 1;
      const cached = mathImageCache.get(
        mathCacheKey(
          block.latex,
          block.displayMode,
          dpr,
          c.styles.blocks.paragraph.color,
        ),
      );
      if (cached) return Math.max(m.minHeight, cached.height);
    }
    return m.minHeight;
  }

  protected intrinsicHeight(c: NodeLayoutCtx): number {
    const m = c.styles.blocks.math;
    return this.contentHeight(c) + m.paddingTop + m.paddingBottom;
  }

  protected draw(box: BlockBounds, c: NodePaintCtx): void {
    const block = c.block as MathBlock;
    const { ctx, state, styles, blockIndex } = c;
    const m = styles.blocks.math;
    const { x, y, width } = box;
    const contentHeight = this.contentHeight(c);
    const contentY = y + m.paddingTop;

    // Hover backdrop over the whole block — signals it is clickable.
    if (state.ui.hoveredMathBlockIndex === blockIndex && block.latex) {
      ctx.fillStyle = m.hoverBackgroundColor;
      ctx.beginPath();
      ctx.roundRect(x, y, width, box.height, m.hoverBorderRadius);
      ctx.fill();
    }

    if (block.latex) {
      const dpr = window.devicePixelRatio || 1;
      const cached = mathImageCache.get(
        mathCacheKey(
          block.latex,
          block.displayMode,
          dpr,
          styles.blocks.paragraph.color,
        ),
      );

      if (cached) {
        // Draw the rendered equation centered, snapping to the physical pixel
        // grid to avoid bilinear-interpolation blur on high-DPI canvases.
        const rawX = x + Math.max(0, (width - cached.width) / 2);
        const rawY =
          contentY + Math.max(0, (contentHeight - cached.height) / 2);
        const drawX = Math.round(rawX * dpr) / dpr;
        const drawY = Math.round(rawY * dpr) / dpr;
        const drawW = Math.round(cached.width * dpr) / dpr;
        const drawH = Math.round(cached.height * dpr) / dpr;
        ctx.drawImage(cached.img, drawX, drawY, drawW, drawH);
      } else {
        // Kick off the async render. When it lands, drop the cached height so
        // the block reflows to the real equation size, then repaint.
        renderMathToImage(
          block.latex,
          block.displayMode,
          styles.blocks.paragraph.color,
          m.errorBackgroundColor,
          () => {
            block.cachedHeight = undefined;
            block.cachedWidth = undefined;
            c.requestRedraw();
          },
        );

        // Draw loading placeholder
        ctx.fillStyle = m.placeholder.textColor;
        ctx.font = "14px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.globalAlpha = 0.5;
        ctx.fillText(
          this.str(state, "rendering"),
          x + width / 2,
          contentY + contentHeight / 2,
        );
      }
    } else {
      // Empty math block — draw the click-to-edit placeholder.
      ctx.fillStyle = m.placeholder.backgroundColor;
      ctx.beginPath();
      ctx.roundRect(x, contentY, width, contentHeight, 6);
      ctx.fill();

      ctx.fillStyle = m.placeholder.textColor;
      ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        this.str(state, "clickToEdit"),
        x + width / 2,
        contentY + contentHeight / 2,
      );
    }
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  readonly markdownTokens: readonly TokenType[] = [MATH_BLOCK];

  outputMarkdown(block: MathBlock): string {
    const b = block;
    if (!b.latex) return "";
    if (b.displayMode) {
      return `$$\n${b.latex}\n$$`;
    }
    return `$${b.latex}$`;
  }

  inputMarkdown(ctx: InputCtx): Block {
    ctx.match(MATH_BLOCK);
    const latex = (ctx.previous() as VisibleToken).content;
    ctx.match(NEWLINE);

    const math: MathBlock = {
      id: ctx.nextBlockId(),
      type: "math",
      latex,
      displayMode: true,
    };
    return math;
  }

  outputHTML(block: MathBlock, ctx: OutputCtx): string {
    const b = block;
    if (!b.latex) return "";
    try {
      if (!ctx.renderMathSVG) throw new Error("no math renderer");
      const svg = ctx.renderMathSVG(b.latex, b.displayMode);
      if (b.displayMode) {
        return `<div style="text-align:center;margin:1em 0;">${svg}</div>`;
      }
      return `<span style="display:inline-block;vertical-align:middle;">${svg}</span>`;
    } catch {
      return `<code>${escapeHtml(b.latex)}</code>`;
    }
  }

  outputText(): string {
    return "";
  }
}

// ─── Math actions ────────────────────────────────────────────────────────────
//
// The math-specific click/hover actions live with the node they act on. The
// handler in `mouseEvents.ts` resolves the hit (clicked chip range, hovered
// block index) and dispatches these via `state.actionBus.dispatchState(...)`.
// All are pure — they touch overlay/hover UI state and emit no ops.

/** An inline-math chip's highlight range (engine-owned hover state). */
interface InlineMathHover {
  blockIndex: number;
  startIndex: number;
  endIndex: number;
}

/**
 * Open the inline-math edit popover for a clicked chip and highlight that chip
 * while the popover is open. The handler resolves the overlay menu (host `math`
 * mark's key + the chip's range as `data`) and the matching hover range. Pure,
 * no ops.
 */
export const OPEN_INLINE_MATH_OVERLAY = stateAction<{
  overlay: Extract<ActiveMenu, { type: "overlay" }>;
  hover: InlineMathHover;
}>("open-inline-math-overlay", (state, { overlay, hover }) => {
  const withOverlay = setActiveMenu(state, overlay);
  return {
    state: {
      ...withOverlay,
      ui: { ...withOverlay.ui, inlineMathHover: hover },
    },
    ops: [],
  };
});

/** Set or clear the hovered block-math index (full-block backdrop). Pure, no ops. */
export const SET_MATH_BLOCK_HOVER = stateAction<{ blockIndex: number | null }>(
  "set-math-block-hover",
  (state, { blockIndex }) => {
    if (blockIndex === state.ui.hoveredMathBlockIndex)
      return { state, ops: [] };
    return {
      state: {
        ...state,
        ui: { ...state.ui, hoveredMathBlockIndex: blockIndex },
      },
      ops: [],
    };
  },
);

/**
 * Set or clear the inline-math chip hover highlight. The handler resolves the
 * chip range under the pointer (or `null`); this installs it only when the range
 * actually changed. Pure, no ops.
 */
export const SET_INLINE_MATH_HOVER = stateAction<{
  hover: InlineMathHover | null;
}>("set-inline-math-hover", (state, { hover }) => {
  const prev = state.ui.inlineMathHover;
  const changed =
    (prev === null) !== (hover === null) ||
    (prev &&
      hover &&
      (prev.blockIndex !== hover.blockIndex ||
        prev.startIndex !== hover.startIndex ||
        prev.endIndex !== hover.endIndex));
  if (!changed) return { state, ops: [] };
  return {
    state: { ...state, ui: { ...state.ui, inlineMathHover: hover } },
    ops: [],
  };
});
