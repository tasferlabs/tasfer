/**
 * Per-glyph metric lookup and the mapping from a symbol's logical font/group to
 * a concrete font face. The metric table is vendored from KaTeX (MIT).
 */
import type { AtomClass } from "./constants.ts";
import fontMetricsData from "./fontMetricsData.js";
import type { SymbolInfo, SymGroup } from "./symbols.ts";

/** A concrete font face — matches both a metric-table key and a WOFF2 basename. */
export type FontVariant =
  | "Main-Regular"
  | "Main-Bold"
  | "Main-Italic"
  | "Main-BoldItalic"
  | "Math-Italic"
  | "Math-BoldItalic"
  | "AMS-Regular"
  | "Size1-Regular"
  | "Size2-Regular"
  | "Size3-Regular"
  | "Size4-Regular"
  | "Caligraphic-Regular"
  | "Fraktur-Regular"
  | "SansSerif-Regular"
  | "Script-Regular"
  | "Typewriter-Regular";

export interface GlyphMetrics {
  readonly depth: number;
  readonly height: number;
  readonly italic: number;
  readonly skew: number;
  readonly width: number;
}

/**
 * Metrics for `char` in `variant`, scaled to `sizeMultiplier`, or null if the
 * face has no glyph there. Uses the first code unit (KaTeX's metric keys are
 * BMP codepoints; surrogate-pair glyphs are handled by dedicated paths).
 */
export function getCharacterMetrics(
  char: string,
  variant: FontVariant,
  sizeMultiplier = 1,
): GlyphMetrics | null {
  const table = fontMetricsData[variant];
  if (!table) return null;
  const tuple = table[char.charCodeAt(0)];
  if (!tuple) return null;
  const [depth, height, italic, skew, width] = tuple;
  return {
    depth: depth * sizeMultiplier,
    height: height * sizeMultiplier,
    italic: italic * sizeMultiplier,
    skew: skew * sizeMultiplier,
    width: width * sizeMultiplier,
  };
}

const GROUP_TO_CLASS: Record<SymGroup, AtomClass> = {
  mathord: "mord",
  textord: "mord",
  op: "mop",
  bin: "mbin",
  rel: "mrel",
  open: "mopen",
  close: "mclose",
  punct: "mpunct",
  inner: "minner",
  accent: "mord",
  spacing: "mord",
};

/** TeX atom class for a symbol's group — drives inter-atom spacing. */
export function atomClassOf(group: SymGroup): AtomClass {
  return GROUP_TO_CLASS[group];
}

/**
 * Concrete face for a math-mode symbol with no explicit font command:
 * ordinary letters/greek (mathord) are italic (Math-Italic); everything else
 * renders in the symbol's own font (main → Main-Regular, ams → AMS-Regular).
 */
export function resolveFontVariant(info: SymbolInfo): FontVariant {
  if (info.group === "mathord") return "Math-Italic";
  return info.font === "ams" ? "AMS-Regular" : "Main-Regular";
}
