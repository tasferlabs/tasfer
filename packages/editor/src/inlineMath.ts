import { renderToSVG } from "./mathjax";
import { getEditorStyles } from "./styles";

export interface InlineMathDims {
  width: number;
  height: number;
  // Distance from the SVG bottom edge below the text baseline (positive = SVG hangs below)
  depthBelowBaseline: number;
}

export interface InlineMathImage extends InlineMathDims {
  bitmap: ImageBitmap;
}

const dimsCache = new Map<string, InlineMathDims | null>();
const imageCache = new Map<string, InlineMathImage>();
const pendingImageRenders = new Set<string>();
let redrawCallback: (() => void) | null = null;

export function setInlineMathRedrawCallback(cb: (() => void) | null): void {
  redrawCallback = cb;
}

function dimsKey(latex: string, fontSize: number): string {
  return `${fontSize}:${latex}`;
}

function imageKey(latex: string, fontSize: number, dpr: number): string {
  return `${fontSize}:${dpr}:${latex}`;
}

// Synchronously compute inline math dimensions in CSS pixels for a given font size.
// Returns null on parse error.
export function getInlineMathDims(
  latex: string,
  fontSize: number,
): InlineMathDims | null {
  const key = dimsKey(latex, fontSize);
  if (dimsCache.has(key)) return dimsCache.get(key) ?? null;

  try {
    const svgString = renderToSVG(latex, false);

    // MathJax emits the inner <svg> with width/height in ex units, which is
    // the source of truth for sizing. The viewBox uses unit-less numbers
    // whose scale isn't fixed across expressions, so we don't rely on it.
    const svgTagMatch = svgString.match(/<svg\b([^>]*)>/);
    if (!svgTagMatch) {
      dimsCache.set(key, null);
      return null;
    }
    const attrs = svgTagMatch[1];
    const widthMatch = attrs.match(/\bwidth="([-\d.]+)ex"/);
    const heightMatch = attrs.match(/\bheight="([-\d.]+)ex"/);
    if (!widthMatch || !heightMatch) {
      dimsCache.set(key, null);
      return null;
    }
    const widthEx = parseFloat(widthMatch[1]);
    const heightEx = parseFloat(heightMatch[1]);

    // 1 ex ≈ fontSize / 2 in CSS pixels for typical fonts.
    const exToPx = fontSize / 2;
    const widthPx = widthEx * exToPx;
    const heightPx = heightEx * exToPx;

    // mjx-container exposes vertical-align in ex units indicating the depth
    // of the formula below the text baseline (negative number). Use it to
    // align the rendered SVG bottom relative to the baseline.
    const valignMatch = svgString.match(/vertical-align:\s*(-?[\d.]+)ex/);
    const valignEx = valignMatch ? parseFloat(valignMatch[1]) : 0;
    const depthBelowBaseline = -valignEx * exToPx;

    const dims: InlineMathDims = {
      width: widthPx,
      height: heightPx,
      depthBelowBaseline,
    };
    dimsCache.set(key, dims);
    return dims;
  } catch {
    dimsCache.set(key, null);
    return null;
  }
}

// Returns a cached ImageBitmap for the rendered math, or null if not ready.
// On miss, schedules an async render and triggers redraw on completion.
export function getInlineMathImage(
  latex: string,
  fontSize: number,
  dpr: number,
): InlineMathImage | null {
  const key = imageKey(latex, fontSize, dpr);
  const cached = imageCache.get(key);
  if (cached) return cached;
  if (pendingImageRenders.has(key)) return null;

  pendingImageRenders.add(key);

  void (async () => {
    try {
      const svgString = renderToSVG(latex, false);
      const color = getEditorStyles().blocks.paragraph.color;

      const inner = svgString.replace(
        /^<mjx-container[^>]*>([\s\S]*)<\/mjx-container>$/,
        "$1",
      );

      const parser = new DOMParser();
      const doc = parser.parseFromString(inner, "image/svg+xml");
      const svgEl = doc.querySelector("svg");
      if (!svgEl) {
        pendingImageRenders.delete(key);
        return;
      }

      svgEl.setAttribute("color", color);
      svgEl.style.color = color;
      for (const rect of svgEl.querySelectorAll("rect[data-background]")) {
        rect.setAttribute("fill", "rgba(128,128,128,0.15)");
      }

      const dims = getInlineMathDims(latex, fontSize);
      if (!dims) {
        pendingImageRenders.delete(key);
        return;
      }

      const renderScale = dpr * 2;
      const pxW = Math.max(1, Math.ceil(dims.width * renderScale));
      const pxH = Math.max(1, Math.ceil(dims.height * renderScale));

      svgEl.setAttribute("width", String(pxW));
      svgEl.setAttribute("height", String(pxH));
      svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");

      const finalSvg = new XMLSerializer().serializeToString(svgEl);
      const blob = new Blob([finalSvg], {
        type: "image/svg+xml;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);

      const img = new Image();
      img.decoding = "sync";
      img.onload = () => {
        const offscreen = document.createElement("canvas");
        offscreen.width = pxW;
        offscreen.height = pxH;
        const ctx = offscreen.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(url);
          pendingImageRenders.delete(key);
          return;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, pxW, pxH);
        URL.revokeObjectURL(url);

        createImageBitmap(offscreen)
          .then((bitmap) => {
            imageCache.set(key, { ...dims, bitmap });
            pendingImageRenders.delete(key);
            redrawCallback?.();
          })
          .catch(() => {
            pendingImageRenders.delete(key);
          });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        pendingImageRenders.delete(key);
      };
      img.src = url;
    } catch {
      pendingImageRenders.delete(key);
    }
  })();

  return null;
}
