// @ts-expect-error - pre-built ESM bundle from mathjax-full CJS
import mathjaxBundle from "./mathjax-bundle.mjs";

const { mathjax, TeX, SVG, liteAdaptor, RegisterHTMLHandler, AllPackages } = mathjaxBundle;

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
