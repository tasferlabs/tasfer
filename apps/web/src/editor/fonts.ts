/**
 * Font loading system for the editor
 * Ensures fonts are properly loaded before text measurement
 */

// Import Poppins font (multiple weights)
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
// Formatted text measurement - handles Char[] with FormatSpan[]
import type { Char, FormatSpan, TextFormat } from "../deserializer/loadPage";
import { getInlineMathDims } from "./inlineMath";

// Import Libre Baskerville font (multiple weights)
import "@fontsource/libre-baskerville/400.css";
import "@fontsource/libre-baskerville/700.css";
// Import Space Grotesk - display face reserved for the "Cypher" wordmark
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import type { FontMetrics, CharacterMetrics } from "./types";
import type FontConfig from "./types";

// Arabic font loading state
let arabicFontsLoaded = false;
let arabicFontLoadingPromise: Promise<void> | null = null;

// Legacy text segment type (for backward compatibility)
interface TextSegment {
  content: string;
  formats?: TextFormat[];
}

export type FontFamily = "poppins" | "libre-baskerville";

export const FONT_STACKS: Record<FontFamily, string> = {
  poppins:
    'Poppins, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "libre-baskerville":
    'Libre Baskerville, Georgia, "Times New Roman", Times, serif',
};

// Font stacks with Arabic fonts prepended (used when Arabic fonts are loaded)
const FONT_STACKS_ARABIC: Record<FontFamily, string> = {
  poppins:
    '"Noto Sans Arabic", Poppins, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "libre-baskerville":
    'Amiri, Libre Baskerville, Georgia, "Times New Roman", Times, serif',
};

/**
 * Get the appropriate font stack, considering whether Arabic fonts are loaded
 */
export function getFontStack(fontFamily: FontFamily): string {
  if (arabicFontsLoaded) {
    return FONT_STACKS_ARABIC[fontFamily];
  }
  return FONT_STACKS[fontFamily];
}

// Latin character set (ASCII 32-126 + common extended Latin)
const LATIN_CHARS =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~" +
  "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ";
// Common font sizes for pre-calculation
// const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 48];
// const FONT_WEIGHTS = ["400", "500", "600", "700"];

// Font loading configuration
const FONT_CONFIGS = [
  { family: "Poppins", weight: "400" },
  { family: "Poppins", weight: "500" },
  { family: "Poppins", weight: "600" },
  { family: "Poppins", weight: "700" },
  { family: "Libre Baskerville", weight: "400" },
  { family: "Libre Baskerville", weight: "700" },
];

const ARABIC_FONT_CONFIGS = [
  { family: "Noto Sans Arabic", weight: "400" },
  { family: "Noto Sans Arabic", weight: "500" },
  { family: "Noto Sans Arabic", weight: "600" },
  { family: "Noto Sans Arabic", weight: "700" },
  { family: "Amiri", weight: "400" },
  { family: "Amiri", weight: "700" },
];

// Font loading state
let fontsLoaded = false;
let fontLoadingPromise: Promise<void> | null = null;

// Callbacks fired once when fonts finish loading
const fontReadyCallbacks: Array<() => void> = [];

/** Register a one-shot callback for when fonts are ready. Fires immediately if already loaded. Returns unsubscribe fn. */
export function onFontsReady(cb: () => void): () => void {
  if (fontsLoaded) {
    cb();
    return () => {};
  }
  fontReadyCallbacks.push(cb);
  return () => {
    const idx = fontReadyCallbacks.indexOf(cb);
    if (idx >= 0) fontReadyCallbacks.splice(idx, 1);
  };
}

/**
 * Check if a specific font is loaded
 */
function isFontLoaded(family: string, weight: string): boolean {
  if (!document.fonts || !document.fonts.check) {
    // Fallback for browsers without FontFace API
    return true;
  }

  try {
    return document.fonts.check(`${weight} 1rem ${family}`);
  } catch (error) {
    console.warn(`Error checking font ${family} ${weight}:`, error);
    return true; // Assume loaded to prevent blocking
  }
}

/**
 * Load a single font with timeout
 */
function loadSingleFont(family: string, weight: string): Promise<void> {
  return new Promise((resolve) => {
    // Check if already loaded
    if (isFontLoaded(family, weight)) {
      resolve();
      return;
    }

    if (document.fonts && document.fonts.load) {
      // Use FontFace API
      document.fonts
        .load(`${weight} 1rem ${family}`)
        .then(() => {
          resolve();
        })
        .catch((error) => {
          console.warn(`Error loading font ${family} ${weight}:`, error);
          resolve(); // Resolve anyway to prevent blocking
        });
    } else {
      // Fallback: create invisible text element and wait for font to load
      const testElement = document.createElement("div");
      testElement.style.cssText = `
        position: absolute;
        left: -9999px;
        top: -9999px;
        font-family: ${family};
        font-weight: ${weight};
        font-size: 16px;
        visibility: hidden;
      `;
      testElement.textContent = "Test";
      document.body.appendChild(testElement);

      // Poll for font loading
      const checkInterval = setInterval(() => {
        if (isFontLoaded(family, weight)) {
          clearInterval(checkInterval);
          document.body.removeChild(testElement);
          resolve();
        }
      }, 100);
    }
  });
}

/**
 * Load all fonts. Metrics are computed lazily on first use per combo.
 */
export async function loadFonts(): Promise<void> {
  if (fontsLoaded) {
    return;
  }

  if (fontLoadingPromise) {
    return fontLoadingPromise;
  }

  fontLoadingPromise = Promise.all(
    FONT_CONFIGS.map(({ family, weight }) => loadSingleFont(family, weight)),
  ).then(() => {
    fontsLoaded = true;
    // Flush cached metrics so they're re-measured with the real fonts
    metricsCache = new Map();
    // Notify listeners (editor re-render)
    const cbs = fontReadyCallbacks.splice(0);
    for (const cb of cbs) cb();
  });

  return fontLoadingPromise;
}

/**
 * Dynamically load Arabic fonts (Noto Sans Arabic + Amiri).
 * Called when the language is set to Arabic. CSS is loaded via dynamic import
 * so the font files are only fetched when needed.
 */
export async function loadArabicFonts(): Promise<void> {
  if (arabicFontsLoaded) return;
  if (arabicFontLoadingPromise) return arabicFontLoadingPromise;

  arabicFontLoadingPromise = (async () => {
    // Dynamically import the CSS files so they're only fetched for Arabic
    await Promise.all([
      import("@fontsource/noto-sans-arabic/400.css"),
      import("@fontsource/noto-sans-arabic/500.css"),
      import("@fontsource/noto-sans-arabic/600.css"),
      import("@fontsource/noto-sans-arabic/700.css"),
      import("@fontsource/amiri/400.css"),
      import("@fontsource/amiri/700.css"),
    ]);

    // Wait for the browser to actually load the font faces
    await Promise.all(
      ARABIC_FONT_CONFIGS.map(({ family, weight }) =>
        loadSingleFont(family, weight),
      ),
    );

    arabicFontsLoaded = true;

    // Flush metrics cache so measurements use the new font stacks
    metricsCache = new Map();

    // Notify listeners so editor re-renders with Arabic fonts
    const cbs = fontReadyCallbacks.splice(0);
    for (const cb of cbs) cb();
  })();

  return arabicFontLoadingPromise;
}

// Global metrics cache (immutable) - keyed by "fontFamily-fontSize-fontWeight"
let metricsCache: ReadonlyMap<string, FontMetrics> = new Map();

// Helper function to create cache key
const createCacheKey = (
  fontFamily: FontFamily,
  fontSize: number,
  fontWeight: string,
): string => {
  return `${fontFamily}-${fontSize}-${fontWeight}`;
};

// Canvas context for measurements (created once)
const measurementCanvas = (() => {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  return canvas.getContext("2d")!;
})();
// Pure function to apply font to context
const applyFont = (
  ctx: CanvasRenderingContext2D,
  fontSize: number,
  fontWeight: string,
  fontFamily: FontFamily,
): void => {
  const fontStack = getFontStack(fontFamily);
  ctx.font = `${fontWeight} ${fontSize}px ${fontStack}`;
};
// Pure function to calculate font metrics
const calculateFontMetrics = (
  fontFamily: FontFamily,
  fontSize: number,
  fontWeight: string,
): FontMetrics => {
  const ctx = measurementCanvas;
  applyFont(ctx, fontSize, fontWeight, fontFamily);
  const textMetrics = ctx.measureText("Mg");

  // Calculate character widths for Latin characters
  const characters = new Map<string, CharacterMetrics>();

  for (const char of LATIN_CHARS) {
    const charMetrics = ctx.measureText(char);
    characters.set(char, {
      width: charMetrics.width,
      height: fontSize,
    });
  }

  // Use font bounding box metrics for consistent line height across all characters
  return {
    fontSize,
    fontWeight,
    fontFamily,
    ascent: textMetrics.fontBoundingBoxAscent,
    descent: textMetrics.fontBoundingBoxDescent,
    characters: characters,
  };
};
// Get font metrics with lazy per-key caching.
// Metrics are computed on first access for each font/size/weight combo,
// avoiding the upfront cost of pre-computing all 80 combinations.
export const getFontMetrics = (
  fontSize: number,
  fontWeight: string,
  fontFamily: FontFamily,
): FontMetrics => {
  const cacheKey = createCacheKey(fontFamily, fontSize, fontWeight);
  const cached = metricsCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  // Calculate on demand
  const metrics = calculateFontMetrics(fontFamily, fontSize, fontWeight);

  // Update cache
  metricsCache = new Map(metricsCache).set(cacheKey, metrics);

  return metrics;
};

// Measure character
export const measureCtxText = (
  text: string,
  fontSize: number,
  fontWeight: string,
  fontFamily: FontFamily,
): number => {
  // Fallback to canvas measurement
  const ctx = measurementCanvas;
  applyFont(ctx, fontSize, fontWeight, fontFamily);
  return ctx.measureText(text).width;
};

// Helper: Check if a char is within a format span
function isCharInSpan(
  charIndex: number,
  span: FormatSpan,
  chars: Char[],
): boolean {
  const startIdx = chars.findIndex((c) => c.id === span.startCharId);
  const endIdx = chars.findIndex((c) => c.id === span.endCharId);

  if (startIdx === -1 || endIdx === -1) return false;

  return charIndex >= startIdx && charIndex <= endIdx;
}

// Helper: Get formats that apply to a character at a given index
export function getFormatsAtIndex(
  charIndex: number,
  chars: Char[],
  formats: FormatSpan[],
): TextFormat[] {
  const activeFormats: TextFormat[] = [];

  for (const span of formats) {
    if (isCharInSpan(charIndex, span, chars)) {
      activeFormats.push(span.format);
    }
  }

  return activeFormats;
}

// === Batching utilities for Arabic/RTL text support ===
// These batch consecutive characters with the same formatting together
// to preserve ligatures and cursive connections in scripts like Arabic

// Create a unique key for a set of formats (for batching comparison)
export function getFormatKey(formats: TextFormat[]): string {
  const keys: string[] = [];
  for (const f of formats) {
    if (f.type === "link") {
      keys.push(`link:${f.url}`);
    } else {
      keys.push(f.type);
    }
  }
  return keys.sort().join("|");
}

// A batch of consecutive characters with the same formatting
export interface TextBatch {
  text: string;
  formats: TextFormat[];
  isBold: boolean;
  isItalic: boolean;
  isCode: boolean;
  isStrikethrough: boolean;
  isLink: boolean;
  isMath: boolean;
  linkUrl?: string;
}

// Batch CRDT characters by formatting within a visible index range
// This preserves Arabic ligatures by keeping same-formatted chars together
export function batchChars(
  chars: Char[],
  formats: FormatSpan[],
  startIndex: number,
  endIndex: number,
): TextBatch[] {
  const batches: TextBatch[] = [];
  let currentBatch: TextBatch | null = null;
  let visibleIndex = 0;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];

    // Skip deleted characters
    if (char.deleted) continue;

    // Check if this character is in the range
    if (visibleIndex < startIndex) {
      visibleIndex++;
      continue;
    }

    if (visibleIndex >= endIndex) {
      break;
    }

    const charFormats = getFormatsAtIndex(i, chars, formats);
    const formatKey = getFormatKey(charFormats);

    if (currentBatch && getFormatKey(currentBatch.formats) === formatKey) {
      // Same formatting, append to current batch
      currentBatch.text += char.char;
    } else {
      // Different formatting, start new batch
      const isBold = charFormats.some((f) => f.type === "bold");
      const isItalic = charFormats.some((f) => f.type === "italic");
      const isCode = charFormats.some((f) => f.type === "code");
      const isStrikethrough = charFormats.some(
        (f) => f.type === "strikethrough",
      );
      const isMath = charFormats.some((f) => f.type === "math");
      const linkFormat = charFormats.find((f) => f.type === "link");

      currentBatch = {
        text: char.char,
        formats: charFormats,
        isBold,
        isItalic,
        isCode,
        isStrikethrough,
        isLink: !!linkFormat,
        isMath,
        linkUrl: linkFormat?.type === "link" ? linkFormat.url : undefined,
      };
      batches.push(currentBatch);
    }

    visibleIndex++;
  }

  return batches;
}

// Measure width of batched text (preserves Arabic ligatures)
export function measureBatchedText(
  batches: TextBatch[],
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
): number {
  let width = 0;

  for (const batch of batches) {
    if (batch.isMath) {
      const dims = getInlineMathDims(batch.text, fontSize);
      if (dims) {
        width += dims.width;
        continue;
      }
      // Fall back to text measurement on render error
    }
    const effectiveFontWeight = batch.isBold ? "bold" : baseFontWeight;
    // Measure the entire batch as a string (preserves ligature widths)
    width += measureCtxText(
      batch.text,
      fontSize,
      effectiveFontWeight,
      fontFamily,
    );
  }

  return width;
}

/**
 * Calculate cumulative widths for all character positions in a range.
 * Optimized for cursor positioning while preserving Arabic ligatures.
 *
 * For Arabic and other connected scripts, ligatures can form across formatting boundaries.
 * To measure positions accurately, we measure from the line start for each position,
 * ensuring ligatures are formed correctly throughout the entire line.
 *
 * @param chars - CRDT character array
 * @param formats - Format spans
 * @param startIndex - Start of visible character range
 * @param endIndex - End of visible character range
 * @param fontSize - Font size in pixels
 * @param baseFontWeight - Base font weight (before bold formatting)
 * @param fontFamily - Font family to use
 * @returns Array where index i contains the cumulative width from startIndex to startIndex+i
 */
export function measureCRDTPositions(
  chars: Char[],
  formats: FormatSpan[],
  startIndex: number,
  endIndex: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
): number[] {
  const lineLength = endIndex - startIndex;
  const positions: number[] = new Array(lineLength + 1);

  positions[0] = 0;

  // For each position, measure from the start to that position
  // This ensures Arabic ligatures are formed correctly across formatting boundaries
  for (let i = 1; i <= lineLength; i++) {
    positions[i] = measureTextUpToIndex(
      chars,
      formats,
      startIndex,
      startIndex + i,
      fontSize,
      baseFontWeight,
      fontFamily,
    );
  }

  return positions;
}

// Measure width of CRDT text (Char[] with FormatSpan[]) up to a specific character position
// Uses batching to preserve Arabic ligature widths
export const measureTextUpToIndex = (
  chars: Char[],
  formats: FormatSpan[],
  startIndex: number,
  endIndex: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  _codePadding: number = 0,
): number => {
  // Use batched measurement to preserve Arabic ligatures
  const batches = batchChars(chars, formats, startIndex, endIndex);

  // Inline-math atomic-span fixup. batchCRDTChars can produce a math batch
  // whose text is a *partial* slice of the span's LaTeX (when the requested
  // range cuts mid-span). measureBatchedText would then run MathJax on
  // unparseable input. Rewrite each math batch to match the wrap convention:
  // the span's first char carries the full SVG width, every other char in
  // the span carries 0. This keeps measurement consistent with rendering and
  // wrapping, so the cursor x stays aligned with the rendered chip.
  if (batches.some((b) => b.isMath)) {
    const visIdxOfId = new Map<string, number>();
    const visibleChars: string[] = [];
    {
      let v = 0;
      for (const c of chars) {
        if (c.deleted) continue;
        visIdxOfId.set(c.id, v);
        visibleChars.push(c.char);
        v++;
      }
    }

    type MathSpan = {
      startVisIdx: number;
      endVisIdx: number;
      latex: string;
    };
    const mathSpans: MathSpan[] = [];
    for (const f of formats) {
      if (f.format.type !== "math") continue;
      const s = visIdxOfId.get(f.startCharId);
      const e = visIdxOfId.get(f.endCharId);
      if (s === undefined || e === undefined) continue;
      mathSpans.push({
        startVisIdx: s,
        endVisIdx: e,
        latex: visibleChars.slice(s, e + 1).join(""),
      });
    }

    let visIdx = startIndex;
    for (const batch of batches) {
      const batchStart = visIdx;
      const batchEnd = batchStart + batch.text.length;
      visIdx = batchEnd;
      if (!batch.isMath) continue;
      const span = mathSpans.find(
        (s) => s.startVisIdx <= batchStart && s.endVisIdx >= batchEnd - 1,
      );
      if (!span) continue;
      if (batchStart === span.startVisIdx) {
        // First char of the span is included → contribute full SVG width.
        // Use the full LaTeX so getInlineMathDims hits the cache key used
        // by the renderer.
        batch.text = span.latex;
      } else {
        // Past the first char of the span → contribute 0 width.
        batch.text = "";
        batch.isMath = false;
      }
    }
  }

  return measureBatchedText(batches, fontSize, baseFontWeight, fontFamily);
};

// Measure total width of CRDT text
export const measureCRDTText = (
  chars: Char[],
  formats: FormatSpan[],
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  codePadding: number = 0,
): number => {
  const visibleLength = chars.filter((c) => !c.deleted).length;
  return measureTextUpToIndex(
    chars,
    formats,
    0,
    visibleLength,
    fontSize,
    baseFontWeight,
    fontFamily,
    codePadding,
  );
};

// Legacy functions for backward compatibility with TextSegment[]

// Measure a single text segment with its formats
export const measureTextSegment = (
  textSegment: TextSegment,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  codePadding: number = 0,
): number => {
  // Determine effective font weight (bold overrides base weight)
  const effectiveFontWeight = textSegment.formats?.some(
    (f) => f.type === "bold",
  )
    ? "bold"
    : baseFontWeight;

  let width = measureCtxText(
    textSegment.content,
    fontSize,
    effectiveFontWeight,
    fontFamily,
  );

  // Add code padding if applicable
  if (textSegment.formats?.some((f) => f.type === "code")) {
    width += codePadding * 2;
  }

  return width;
};

// Measure total width of formatted text segments
export const measureFormattedText = (
  segments: TextSegment[],
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  codePadding: number = 0,
): number => {
  let totalWidth = 0;
  for (const segment of segments) {
    totalWidth += measureTextSegment(
      segment,
      fontSize,
      baseFontWeight,
      fontFamily,
      codePadding,
    );
  }
  return totalWidth;
};

// Measure width of formatted text up to a specific character position
// This is used for cursor positioning
export const measureFormattedTextUpToIndex = (
  segments: TextSegment[],
  startIndex: number,
  endIndex: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  codePadding: number = 0,
): number => {
  let width = 0;
  let currentIndex = 0;

  for (const segment of segments) {
    const segmentStart = currentIndex;
    const segmentEnd = currentIndex + segment.content.length;

    if (segmentEnd <= startIndex) {
      // This entire segment is before our measurement range
      // Skip it (don't add to width)
      currentIndex = segmentEnd;
      continue;
    }

    if (segmentStart >= endIndex) {
      // We've passed our endpoint
      break;
    }

    // This segment overlaps with our range [startIndex, endIndex)
    const overlapStart = Math.max(segmentStart, startIndex);
    const overlapEnd = Math.min(segmentEnd, endIndex);
    const textToMeasure = segment.content.substring(
      overlapStart - segmentStart,
      overlapEnd - segmentStart,
    );

    const effectiveFontWeight = segment.formats?.some((f) => f.type === "bold")
      ? "bold"
      : baseFontWeight;

    let segmentWidth = measureCtxText(
      textToMeasure,
      fontSize,
      effectiveFontWeight,
      fontFamily,
    );

    width += segmentWidth;

    // Add code padding only if we've MOVED PAST this segment to the next one
    // (not just at the end boundary, but actually beyond it)
    // The cursor at the end of a code segment should be before the right padding
    if (
      segment.formats?.some((f) => f.type === "code") &&
      overlapEnd === segmentEnd &&
      endIndex > segmentEnd
    ) {
      width += codePadding * 2;
    }

    currentIndex = segmentEnd;
  }

  return width;
};

// Helper function to check if a character is CJK (Chinese, Japanese, Korean)
// Exported for use in word boundary detection
export const isCJKCharacter = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return (
    // CJK Unified Ideographs
    (code >= 0x4e00 && code <= 0x9fff) ||
    // CJK Unified Ideographs Extension A
    (code >= 0x3400 && code <= 0x4dbf) ||
    // CJK Unified Ideographs Extension B-F
    (code >= 0x20000 && code <= 0x2a6df) ||
    // CJK Compatibility Ideographs
    (code >= 0xf900 && code <= 0xfaff) ||
    // Hiragana
    (code >= 0x3040 && code <= 0x309f) ||
    // Katakana
    (code >= 0x30a0 && code <= 0x30ff) ||
    // Hangul Syllables
    (code >= 0xac00 && code <= 0xd7af)
  );
};

// Helper function to check if text contains CJK characters
export const containsCJK = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    if (isCJKCharacter(text[i])) {
      return true;
    }
  }
  return false;
};

// Wrap CRDT text (Char[] with FormatSpan[]) for rendering
// Uses incremental character measurement for O(n) complexity
export const wrapText = (
  chars: Char[],
  formats: FormatSpan[],
  maxWidth: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  _codePadding: number = 0,
  _compositionRange: { start: number; end: number } | null = null,
): WrappedLine[] => {
  // Get visible text
  const visibleChars = chars.filter((c) => !c.deleted);
  const fullText = visibleChars.map((c) => c.char).join("");

  if (fullText.length === 0) {
    return [{ text: "", consumedSpace: false }];
  }

  // Check if text contains CJK characters
  const hasCJK = containsCJK(fullText);

  // Pre-compute format info for each visible character (O(n) once)
  // Map from visible index to original chars array index
  const visibleToOriginalIndex: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (!chars[i].deleted) {
      visibleToOriginalIndex.push(i);
    }
  }

  // Helper to get font weight for a character at visible index
  const getFontWeightAtIndex = (visibleIndex: number): string => {
    const originalIndex = visibleToOriginalIndex[visibleIndex];
    const charFormats = getFormatsAtIndex(originalIndex, chars, formats);
    return charFormats.some((f) => f.type === "bold") ? "bold" : baseFontWeight;
  };

  // Pre-compute inline-math span ranges (visible indices) and their rendered
  // widths. The math chip is drawn as a single SVG image whose width is the
  // rendered width — not the sum of the source LaTeX character widths — so
  // wrapping must treat the span as an atomic unit at the rendered width.
  // We attribute the full span width to the first char and 0 to the rest,
  // which makes the span effectively non-breakable (subsequent 0-width chars
  // can never trigger a wrap on their own).
  const mathSpanFirstWidth = new Map<number, number>();
  const mathSpanIsTail = new Set<number>();
  for (const span of formats) {
    if (span.format.type !== "math") continue;
    const startOrig = chars.findIndex((c) => c.id === span.startCharId);
    const endOrig = chars.findIndex((c) => c.id === span.endCharId);
    if (startOrig === -1 || endOrig === -1) continue;
    let startVis = -1;
    let endVis = -1;
    for (let i = 0; i < visibleToOriginalIndex.length; i++) {
      const orig = visibleToOriginalIndex[i];
      if (orig === startOrig) startVis = i;
      if (orig === endOrig) endVis = i;
    }
    if (startVis === -1 || endVis === -1) continue;
    const latex = visibleChars
      .slice(startVis, endVis + 1)
      .map((c) => c.char)
      .join("");
    const dims = getInlineMathDims(latex, fontSize);
    if (!dims) continue; // fall through to plain-text widths on render error
    mathSpanFirstWidth.set(startVis, dims.width);
    for (let i = startVis + 1; i <= endVis; i++) {
      mathSpanIsTail.add(i);
    }
  }

  const lines: WrappedLine[] = [];
  let currentLine = "";
  let currentLineWidth = 0;

  // Track character widths for the current line (for backtracking on word wrap)
  let lineCharWidths: number[] = [];

  for (
    let visibleIndex = 0;
    visibleIndex < visibleChars.length;
    visibleIndex++
  ) {
    const char = visibleChars[visibleIndex].char;
    const isCJK = isCJKCharacter(char);
    const isSpace = char === " ";

    // Measure this single character (O(1) per character).
    // Inline math: first char of the span carries the full rendered width;
    // remaining chars in the span carry 0 width so the span is atomic.
    let charWidth: number;
    const mathFirstWidth = mathSpanFirstWidth.get(visibleIndex);
    if (mathFirstWidth !== undefined) {
      charWidth = mathFirstWidth;
    } else if (mathSpanIsTail.has(visibleIndex)) {
      charWidth = 0;
    } else {
      const fontWeight = getFontWeightAtIndex(visibleIndex);
      charWidth = measureCtxText(char, fontSize, fontWeight, fontFamily);
    }

    // Check if adding this character would exceed max width
    if (currentLineWidth + charWidth > maxWidth && currentLine.length > 0) {
      // Line is full, need to wrap
      if (isCJK || isSpace || hasCJK) {
        // For CJK or spaces, break here
        lines.push({ text: currentLine, consumedSpace: isSpace });
        currentLine = isSpace ? "" : char;
        currentLineWidth = isSpace ? 0 : charWidth;
        lineCharWidths = isSpace ? [] : [charWidth];
      } else {
        // Latin character - try to find last space in current line
        const lastSpaceIndex = currentLine.lastIndexOf(" ");
        if (lastSpaceIndex > 0) {
          // Break at the space
          const lineToAdd = currentLine.substring(0, lastSpaceIndex);
          lines.push({ text: lineToAdd, consumedSpace: true });

          // Start new line with text after the space + current char
          const afterSpace = currentLine.substring(lastSpaceIndex + 1);
          currentLine = afterSpace + char;

          // Recalculate width for the carried-over text
          // Sum up the widths of characters after the space
          const charsAfterSpace = currentLine.length - 1; // -1 for new char
          let newLineWidth = charWidth;
          for (let i = 0; i < charsAfterSpace; i++) {
            newLineWidth += lineCharWidths[lastSpaceIndex + 1 + i];
          }
          currentLineWidth = newLineWidth;

          // Update lineCharWidths
          lineCharWidths = lineCharWidths.slice(lastSpaceIndex + 1);
          lineCharWidths.push(charWidth);
        } else {
          // No space found, force break
          lines.push({ text: currentLine, consumedSpace: false });
          currentLine = char;
          currentLineWidth = charWidth;
          lineCharWidths = [charWidth];
        }
      }
    } else {
      // Character fits on current line
      currentLine += char;
      currentLineWidth += charWidth;
      lineCharWidths.push(charWidth);
    }
  }

  // Add remaining text
  if (currentLine) {
    lines.push({ text: currentLine, consumedSpace: false });
  }

  return lines.length > 0 ? lines : [{ text: "", consumedSpace: false }];
};

// Character-based wrapping for CJK text (allows breaks at any character)
const wrapFormattedTextCJK = (
  segments: TextSegment[],
  fullText: string,
  charToSegment: number[],
  maxWidth: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  codePadding: number,
  compositionRange: { start: number; end: number } | null = null,
): WrappedLine[] => {
  const lines: WrappedLine[] = [];
  let currentLine = "";
  let currentLineWidth = 0;
  let lineStartIndex = 0;

  // Helper to measure a substring with its formatting
  const measureSubstring = (start: number, end: number): number => {
    return measureFormattedTextUpToIndex(
      segments,
      start,
      end,
      fontSize,
      baseFontWeight,
      fontFamily,
      codePadding,
    );
  };

  for (let i = 0; i < fullText.length; i++) {
    const char = fullText[i];
    const isCJK = isCJKCharacter(char);
    const isSpace = char === " ";
    const isCompositionStart = compositionRange && i === compositionRange.start;
    const isInComposition =
      compositionRange &&
      i >= compositionRange.start &&
      i < compositionRange.end;

    // Measure the character
    const segIdx = charToSegment[i];
    const segment = segments[segIdx];
    const fontWeight = segment.formats?.some((f) => f.type === "bold")
      ? "bold"
      : baseFontWeight;
    const charWidth = measureCtxText(char, fontSize, fontWeight, fontFamily);

    // If this is the start of composition text, check if entire composition fits on current line
    if (isCompositionStart && currentLine.length > 0 && compositionRange) {
      const compositionWidth = measureSubstring(
        compositionRange.start,
        compositionRange.end,
      );

      // If composition would overflow, break to new line before starting composition
      // But only if the composition itself fits on one line
      if (
        currentLineWidth + compositionWidth > maxWidth &&
        compositionWidth <= maxWidth
      ) {
        lines.push({ text: currentLine, consumedSpace: false });
        currentLine = char;
        currentLineWidth = charWidth;
        lineStartIndex = i;
        continue;
      }
    }

    // Check if adding this character would exceed max width
    if (currentLineWidth + charWidth > maxWidth && currentLine.length > 0) {
      // Don't break within composition text UNLESS the composition itself is too long
      if (isInComposition && compositionRange) {
        const compositionWidth = measureSubstring(
          compositionRange.start,
          compositionRange.end,
        );

        // Only keep composition together if it fits on one line by itself
        if (compositionWidth <= maxWidth) {
          // Skip wrapping within composition - keep adding to current line
          currentLine += char;
          currentLineWidth += charWidth;
          continue;
        }
        // Otherwise, allow normal wrapping to happen (fall through)
      }

      // Line is full, need to wrap
      // For CJK characters, we can break immediately
      // For Latin text, try to break at the previous space if possible
      if (isCJK || isSpace) {
        // Break here
        lines.push({ text: currentLine, consumedSpace: isSpace });
        currentLine = isSpace ? "" : char;
        currentLineWidth = isSpace ? 0 : charWidth;
        lineStartIndex = isSpace ? i + 1 : i;
      } else {
        // Latin character - try to find last space in current line
        const lastSpaceIndex = currentLine.lastIndexOf(" ");
        if (lastSpaceIndex > 0) {
          // Break at the space
          const lineToAdd = currentLine.substring(0, lastSpaceIndex);
          lines.push({ text: lineToAdd, consumedSpace: true });

          // Start new line with text after the space
          currentLine = currentLine.substring(lastSpaceIndex + 1) + char;
          const newLineStart = lineStartIndex + lastSpaceIndex + 1;
          currentLineWidth = measureSubstring(newLineStart, i + 1);
          lineStartIndex = newLineStart;
        } else {
          // No space found, force break
          lines.push({ text: currentLine, consumedSpace: false });
          currentLine = char;
          currentLineWidth = charWidth;
          lineStartIndex = i;
        }
      }
    } else {
      // Character fits on current line
      currentLine += char;
      currentLineWidth += charWidth;
    }
  }

  // Add remaining text
  if (currentLine) {
    lines.push({ text: currentLine, consumedSpace: false });
  }

  return lines.length > 0 ? lines : [{ text: "", consumedSpace: false }];
};

// Line wrapping result with information about consumed characters
export interface WrappedLine {
  text: string;
  consumedSpace: boolean; // True if this line consumed a trailing space character
}

// Wrap formatted text (TextSegment[]) to lines with information about consumed spaces
export const wrapFormattedText = (
  segments: TextSegment[],
  maxWidth: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  codePadding: number = 0,
): string[] => {
  const result = wrapFormattedTextDetailed(
    segments,
    maxWidth,
    fontSize,
    baseFontWeight,
    fontFamily,
    codePadding,
  );
  return result.map((line) => line.text);
};

// Internal function that returns detailed line information
export const wrapFormattedTextDetailed = (
  segments: TextSegment[],
  maxWidth: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  codePadding: number = 0,
  compositionRange: { start: number; end: number } | null = null,
): WrappedLine[] => {
  // Convert segments to plain text for wrapping
  const fullText = segments.map((s) => s.content).join("");

  // Build a character-to-segment map for accurate measurement
  const charToSegment: number[] = [];
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    for (let i = 0; i < segments[segIdx].content.length; i++) {
      charToSegment.push(segIdx);
    }
  }

  // Check if text contains CJK characters
  const hasCJK = containsCJK(fullText);

  // If text contains CJK, use character-based wrapping
  if (hasCJK) {
    return wrapFormattedTextCJK(
      segments,
      fullText,
      charToSegment,
      maxWidth,
      fontSize,
      baseFontWeight,
      fontFamily,
      codePadding,
      compositionRange,
    );
  }

  // Otherwise use word-based wrapping (original logic)
  const lines: WrappedLine[] = [];
  const words = fullText.split(" ");
  let currentLine = "";
  let currentLineWidth = 0;
  let currentCharIndex = 0;

  // Helper to measure a substring with its formatting using measureFormattedTextUpToIndex
  const measureSubstring = (start: number, end: number): number => {
    return measureFormattedTextUpToIndex(
      segments,
      start,
      end,
      fontSize,
      baseFontWeight,
      fontFamily,
      codePadding,
    );
  };

  // Measure space with base weight
  const spaceWidth = measureCtxText(" ", fontSize, baseFontWeight, fontFamily);

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const wordStart = currentCharIndex;
    const wordEnd = currentCharIndex + word.length;
    const wordWidth = measureSubstring(wordStart, wordEnd);

    // Check if this word contains composition start
    const wordContainsCompositionStart =
      compositionRange &&
      compositionRange.start >= wordStart &&
      compositionRange.start < wordEnd;

    // Calculate space needed for this word including preceding space if line not empty
    const spaceIfNeeded = currentLine ? spaceWidth : 0;

    // If word contains composition start and would overflow, force new line
    if (
      wordContainsCompositionStart &&
      currentLine &&
      currentLineWidth + spaceIfNeeded + wordWidth > maxWidth
    ) {
      // Break to new line before composition
      lines.push({ text: currentLine, consumedSpace: false });
      currentLine = word;
      currentLineWidth = wordWidth;
      currentCharIndex = wordEnd + (i < words.length - 1 ? 1 : 0);
    } else if (currentLineWidth + spaceIfNeeded + wordWidth <= maxWidth) {
      // Fits on current line
      currentLine = currentLine ? currentLine + " " + word : word;
      currentLineWidth += spaceIfNeeded + wordWidth;
      currentCharIndex = wordEnd + (i < words.length - 1 ? 1 : 0); // +1 for space
    } else {
      // Does not fit. Push current line if it has content.
      if (currentLine) {
        lines.push({ text: currentLine, consumedSpace: true });
        currentLine = "";
        currentLineWidth = 0;
      }

      // Now check if the word itself fits on a new line
      if (wordWidth <= maxWidth) {
        currentLine = word;
        currentLineWidth = wordWidth;
        currentCharIndex = wordEnd + (i < words.length - 1 ? 1 : 0);
      } else {
        // Word is too long, must split by character
        // But don't split if word contains composition text - keep it together
        // UNLESS the composition itself is too long to fit on one line
        const wordContainsComposition =
          compositionRange &&
          compositionRange.start < wordEnd &&
          compositionRange.end > wordStart;

        if (wordContainsComposition) {
          const compositionWidth = measureSubstring(
            compositionRange.start,
            compositionRange.end,
          );

          // Only keep composition together if it fits on one line by itself
          if (compositionWidth <= maxWidth) {
            // Don't split composition text - just add the whole word even if it overflows
            currentLine = word;
            currentLineWidth = wordWidth;
            currentCharIndex = wordEnd + (i < words.length - 1 ? 1 : 0);
          } else {
            // Composition is too long, allow it to be split
            let remainingWordStart = wordStart;

            while (remainingWordStart < wordEnd) {
              let splitIndex = remainingWordStart;
              let currentWidth = 0;

              for (let j = remainingWordStart; j < wordEnd; j++) {
                const segIdx = charToSegment[j];
                const segment = segments[segIdx];
                const fontWeight = segment.formats?.some(
                  (f) => f.type === "bold",
                )
                  ? "bold"
                  : baseFontWeight;
                const charWidth = measureCtxText(
                  fullText[j],
                  fontSize,
                  fontWeight,
                  fontFamily,
                );

                if (
                  currentWidth + charWidth > maxWidth &&
                  j > remainingWordStart
                ) {
                  splitIndex = j;
                  break;
                }
                currentWidth += charWidth;
                splitIndex = j + 1;
              }

              if (splitIndex === remainingWordStart) splitIndex++;

              const chunk = fullText.substring(remainingWordStart, splitIndex);
              lines.push({ text: chunk, consumedSpace: false });
              remainingWordStart = splitIndex;
            }

            currentLine = "";
            currentLineWidth = 0;
            currentCharIndex = wordEnd + (i < words.length - 1 ? 1 : 0);
          }
        } else {
          // Word is too long, must split by character
          let remainingWordStart = wordStart;

          while (remainingWordStart < wordEnd) {
            let splitIndex = remainingWordStart;
            let currentWidth = 0;

            for (let j = remainingWordStart; j < wordEnd; j++) {
              const segIdx = charToSegment[j];
              const segment = segments[segIdx];
              const fontWeight = segment.formats?.some((f) => f.type === "bold")
                ? "bold"
                : baseFontWeight;
              const charWidth = measureCtxText(
                fullText[j],
                fontSize,
                fontWeight,
                fontFamily,
              );

              if (
                currentWidth + charWidth > maxWidth &&
                j > remainingWordStart
              ) {
                splitIndex = j;
                break;
              }
              currentWidth += charWidth;
              splitIndex = j + 1;
            }

            if (splitIndex === remainingWordStart) splitIndex++;

            const chunk = fullText.substring(remainingWordStart, splitIndex);
            // Word is being split mid-word, no space consumed
            lines.push({ text: chunk, consumedSpace: false });
            remainingWordStart = splitIndex;
          }

          currentLine = "";
          currentLineWidth = 0;
          currentCharIndex = wordEnd + (i < words.length - 1 ? 1 : 0);
        }
      }
    }
  }

  if (currentLine) {
    lines.push({ text: currentLine, consumedSpace: false });
  }

  return lines.length > 0 ? lines : [{ text: "", consumedSpace: false }];
};

// Global font configuration - can be changed at runtime
let globalFontConfig: FontConfig = {
  fontFamily: "poppins",
};

// Callback for font family changes (used to invalidate caches)
let fontChangeCallback: (() => void) | null = null;

// Register a callback to be called when font family changes
export const onFontFamilyChange = (callback: () => void): void => {
  fontChangeCallback = callback;
};

// Get the current font family
export const getCurrentFontFamily = (): FontFamily =>
  globalFontConfig.fontFamily;

// Set the current font family
export const setCurrentFontFamily = (fontFamily: FontFamily): void => {
  const previousFontFamily = globalFontConfig.fontFamily;

  globalFontConfig = {
    fontFamily,
  };

  // If font family actually changed, notify callback to invalidate caches
  if (previousFontFamily !== fontFamily && fontChangeCallback) {
    fontChangeCallback();
  }
};
