import mathjaxBundle from "../mathjax-bundle.mjs";

const { mathjax, TeX, SVG, liteAdaptor, RegisterHTMLHandler, AllPackages } =
  mathjaxBundle;

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const doc = mathjax.document("", { InputJax: tex, OutputJax: svg });

/**
 * Render LaTeX to a self-contained SVG string.
 * MathJax SVG output uses <path> elements for glyphs, so no external fonts needed.
 */
export function renderToSVG(latex: string, displayMode: boolean): string {
  const node = doc.convert(latex, { display: displayMode });
  const svgString = adaptor.outerHTML(node);
  doc.clear();
  return svgString;
}

/**
 * Check if a LaTeX string is valid (no merror nodes in output).
 */
export function isValidLatex(latex: string, displayMode: boolean): boolean {
  try {
    const node = doc.convert(latex, { display: displayMode });
    const html = adaptor.outerHTML(node);
    doc.clear();
    return !html.includes('data-mml-node="merror"');
  } catch {
    return false;
  }
}
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
function dimsKey(latex: string, fontSize: number): string {
  return `${fontSize}:${latex}`;
}
function imageKey(
  latex: string,
  fontSize: number,
  dpr: number,
  color: string,
): string {
  // `color` is part of the key so a theme change (new text color) produces a
  // fresh bitmap instead of serving the previous theme's colored glyphs.
  return `${fontSize}:${dpr}:${color}:${latex}`;
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
  color: string,
  errorBackgroundColor: string,
  onReady?: () => void,
): InlineMathImage | null {
  const key = imageKey(latex, fontSize, dpr, color);
  const cached = imageCache.get(key);
  if (cached) return cached;
  if (pendingImageRenders.has(key)) return null;

  pendingImageRenders.add(key);

  void (async () => {
    try {
      const svgString = renderToSVG(latex, false);

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
        rect.setAttribute("fill", errorBackgroundColor);
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
            onReady?.();
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
