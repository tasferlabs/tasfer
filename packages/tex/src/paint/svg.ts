/**
 * SVG backend — the same box-tree walk as the canvas painter, emitting an SVG
 * string instead of drawing. Used for the host's DOM live-preview and HTML
 * export (the engine's primary output is canvas; this is the interop path).
 *
 * Glyphs become `<text>` referencing the loaded font families, so the SVG
 * renders correctly wherever those `@font-face`s are available (the app loads
 * them via `loadFonts`).
 */
import type { Box } from "../layout/box";
import { fontFamily } from "../fonts/fonts";
import type { MathLayout } from "../index";

export interface ToSvgOptions {
  color?: string;
}

/** Render a layout to a self-described `<svg>` string (origin at the baseline). */
export function toSVG(layout: MathLayout, opts: ToSvgOptions = {}): string {
  const color = opts.color ?? "#000";
  const pad = 1;
  const w = layout.width + pad * 2;
  const h = layout.height + layout.depth + pad * 2;
  const originX = pad;
  const originY = layout.height + pad; // baseline y within the viewBox
  const body: string[] = [];
  emit(layout.box, originX, originY, layout.fontSize, color, body);
  // overflow: visible — the metric table records TeX layout extents, not ink
  // bounds, and some glyph ink legitimately overshoots them (°'s ring, italic
  // overhang). Canvas never clips such ink; without this the SVG viewBox would.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}" height="${fmt(h)}" ` +
    `viewBox="0 0 ${fmt(w)} ${fmt(h)}" ` +
    `style="vertical-align: ${fmt(-layout.depth)}px; overflow: visible;">${body.join("")}</svg>`
  );
}

function emit(
  box: Box,
  x: number,
  y: number,
  fs: number,
  color: string,
  out: string[],
): void {
  switch (box.type) {
    case "glyph": {
      if (box.char === "" || (box.width === 0 && box.height === 0)) return;
      const fill = color;
      const size = box.size * fs;
      const t =
        box.yScale != null && box.yScale !== 1
          ? ` transform="translate(${fmt(x)} ${fmt(y)}) scale(1 ${fmt(box.yScale)})"`
          : "";
      const px = t ? 0 : x;
      const py = t ? 0 : y;
      // A text-fallback glyph (CJK, …) keeps the host font it was measured with.
      const family = box.textFont ?? fontFamily(box.variant);
      out.push(
        `<text x="${fmt(px)}" y="${fmt(py)}"${t} ` +
          `font-family="${family}" font-size="${fmt(size)}" ` +
          `fill="${fill}">${escapeXml(box.char)}</text>`,
      );
      break;
    }
    case "rule":
      out.push(
        `<rect x="${fmt(x)}" y="${fmt(y - box.height * fs)}" ` +
          `width="${fmt(box.width * fs)}" height="${fmt((box.height + box.depth) * fs)}" ` +
          `fill="${color}"/>`,
      );
      break;
    case "path": {
      const d = box.commands
        .map(([op, px, py]) => `${op}${fmt(x + px * fs)} ${fmt(y + py * fs)}`)
        .join(" ");
      if (box.strokeWidth != null) {
        out.push(
          `<path d="${d}" fill="none" stroke="${color}" ` +
            `stroke-width="${fmt(box.strokeWidth * fs)}"/>`,
        );
      } else {
        out.push(`<path d="${d}" fill="${color}"/>`);
      }
      break;
    }
    case "placeholder":
      // A faint translucent block marking an empty, editable slot.
      out.push(
        `<rect x="${fmt(x)}" y="${fmt(y - box.height * fs)}" ` +
          `width="${fmt(box.width * fs)}" height="${fmt((box.height + box.depth) * fs)}" ` +
          `fill="${color}" fill-opacity="0.12"/>`,
      );
      break;
    case "list":
      for (const child of box.children) {
        emit(child.box, x + child.dx * fs, y + child.dy * fs, fs, color, out);
      }
      break;
  }
}

function fmt(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );
}
