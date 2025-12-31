/**
 * Font loading system for the editor
 * Ensures fonts are properly loaded before text measurement
 */

// Import Poppins font (multiple weights)
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
// Formatted text measurement - handles Text[] with formats
import type { Text } from "../deserializer/loadPage";

// Import Merriweather font (multiple weights)
import "@fontsource/merriweather/400.css";
import "@fontsource/merriweather/700.css";
import type { FontMetrics, CharacterMetrics } from "./types";
import type FontConfig from "./types";

export type FontFamily = "poppins" | "merriweather";

export const FONT_STACKS: Record<FontFamily, string> = {
  poppins:
    'Poppins, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  merriweather: 'Merriweather, Georgia, "Times New Roman", Times, serif',
};

// Latin character set (ASCII 32-126 + common extended Latin)
const LATIN_CHARS =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~" +
  "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ";
// Common font sizes for pre-calculation
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 48];
const FONT_WEIGHTS = ["400", "500", "600", "700"];

// Font loading configuration
const FONT_CONFIGS = [
  { family: "Poppins", weight: "400" },
  { family: "Poppins", weight: "500" },
  { family: "Poppins", weight: "600" },
  { family: "Poppins", weight: "700" },
  { family: "Merriweather", weight: "400" },
  { family: "Merriweather", weight: "700" },
];

// Font loading state
let fontsLoaded = false;
let fontLoadingPromise: Promise<void> | null = null;

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
 * Load all fonts with progress tracking
 */
export async function loadFonts(): Promise<void> {
  if (fontsLoaded) {
    return;
  }

  if (fontLoadingPromise) {
    return fontLoadingPromise;
  }

  fontLoadingPromise = Promise.all(
    FONT_CONFIGS.map(({ family, weight }) => loadSingleFont(family, weight))
  ).then(() => {
    fontsLoaded = true;
  });

  return fontLoadingPromise;
}

// Global metrics cache (immutable) - keyed by "fontFamily-fontSize-fontWeight"
let metricsCache: ReadonlyMap<string, FontMetrics> = new Map();

// Helper function to create cache key
const createCacheKey = (
  fontFamily: FontFamily,
  fontSize: number,
  fontWeight: string
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
  fontFamily: FontFamily
): void => {
  const fontStack = FONT_STACKS[fontFamily];
  ctx.font = `${fontWeight} ${fontSize}px ${fontStack}`;
};
// Pure function to calculate font metrics
const calculateFontMetrics = (
  fontFamily: FontFamily,
  fontSize: number,
  fontWeight: string
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
// Pure function to initialize metrics cache
const initializeMetricsCache = (): ReadonlyMap<string, FontMetrics> => {
  const metrics = new Map<string, FontMetrics>();

  const fontFamilies: FontFamily[] = ["poppins", "merriweather"];

  for (const fontFamily of fontFamilies) {
    for (const fontSize of FONT_SIZES) {
      for (const fontWeight of FONT_WEIGHTS) {
        const key = createCacheKey(fontFamily, fontSize, fontWeight);
        metrics.set(
          key,
          calculateFontMetrics(fontFamily, fontSize, fontWeight)
        );
      }
    }
  }

  return metrics;
};
// Cache initialization state
let cacheInitialized = false;
// Initialize metrics cache immediately - fail if fonts not loaded
function initializeCache(): void {
  if (cacheInitialized) {
    return;
  }

  // Check if fonts are loaded using document.fonts API
  if (typeof document !== "undefined" && document.fonts) {
    const fontsToCheck = ["Poppins", "Merriweather"];

    for (const fontFamily of fontsToCheck) {
      if (!document.fonts.check(`16px ${fontFamily}`)) {
        throw new Error(
          `Font ${fontFamily} is not loaded. Ensure fonts are loaded before using text measurement.`
        );
      }
    }
  }

  try {
    metricsCache = initializeMetricsCache();
    cacheInitialized = true;
  } catch (error) {
    console.error("Failed to initialize text measurement cache:", error);
    throw error;
  }
}

// Get font metrics with caching

export const getFontMetrics = (
  fontSize: number,
  fontWeight: string,
  fontFamily: FontFamily
): FontMetrics => {
  if (!cacheInitialized) {
    initializeCache(); // This will throw if fonts not loaded
  }

  const cacheKey = createCacheKey(fontFamily, fontSize, fontWeight);
  const cached = metricsCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  // Calculate new metrics
  const metrics = calculateFontMetrics(fontFamily, fontSize, fontWeight);

  // Update cache immutably
  metricsCache = new Map(metricsCache).set(cacheKey, metrics);

  return metrics;
};

// Measure character
export const measureText = (
  text: string,
  fontSize: number,
  fontWeight: string,
  fontFamily: FontFamily
): number => {
  // Fallback to canvas measurement
  const ctx = measurementCanvas;
  applyFont(ctx, fontSize, fontWeight, fontFamily);
  return ctx.measureText(text).width;
};

// Text wrapping function
export const wrapText = (
  text: string,
  maxWidth: number,
  fontSize: number,
  fontWeight: string,
  fontFamily: FontFamily
): string[] => {
  const lines: string[] = [];
  const words = text.split(" ");
  let currentLine = "";
  let currentLineWidth = 0;

  const spaceWidth = measureText(" ", fontSize, fontWeight, fontFamily);

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const wordWidth = measureText(word, fontSize, fontWeight, fontFamily);

    // Calculate space needed for this word including preceding space if line not empty
    const spaceIfNeeded = currentLine ? spaceWidth : 0;

    if (currentLineWidth + spaceIfNeeded + wordWidth <= maxWidth) {
      // Fits on current line
      currentLine = currentLine ? currentLine + " " + word : word;
      currentLineWidth += spaceIfNeeded + wordWidth;
    } else {
      // Does not fit. Push current line if it has content.
      if (currentLine) {
        lines.push(currentLine);
        currentLine = "";
        currentLineWidth = 0;
      }

      // Now check if the word itself fits on a new line
      if (wordWidth <= maxWidth) {
        currentLine = word;
        currentLineWidth = wordWidth;
      } else {
        // Word is too long, must split
        let remainingWord = word;

        while (remainingWord) {
          // Check if remaining fits
          const remainingWidth = measureText(
            remainingWord,
            fontSize,
            fontWeight,
            fontFamily
          );
          if (remainingWidth <= maxWidth) {
            currentLine = remainingWord;
            currentLineWidth = remainingWidth;
            remainingWord = "";
            break;
          }

          // Find split index
          let currentWidth = 0;
          let splitIndex = 0;
          for (let j = 0; j < remainingWord.length; j++) {
            const charWidth = measureText(
              remainingWord[j],
              fontSize,
              fontWeight,
              fontFamily
            );
            if (currentWidth + charWidth > maxWidth) {
              splitIndex = j;
              break;
            }
            currentWidth += charWidth;
          }

          // Safety for very narrow maxWidth (smaller than 1 char)
          if (splitIndex === 0) splitIndex = 1;

          const chunk = remainingWord.substring(0, splitIndex);
          lines.push(chunk);
          remainingWord = remainingWord.substring(splitIndex);
        }
      }
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [""];
};

// Measure a single text segment with its formats
export const measureTextSegment = (
  textSegment: Text,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  codePadding: number = 0
): number => {
  // Determine effective font weight (bold overrides base weight)
  const effectiveFontWeight = textSegment.formats?.some(
    (f) => f.type === "bold"
  )
    ? "bold"
    : baseFontWeight;

  let width = measureText(
    textSegment.content,
    fontSize,
    effectiveFontWeight,
    fontFamily
  );

  // Add code padding if applicable
  if (textSegment.formats?.some((f) => f.type === "code")) {
    width += codePadding * 2;
  }

  return width;
};

// Measure total width of formatted text segments
export const measureFormattedText = (
  segments: Text[],
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  codePadding: number = 0
): number => {
  let totalWidth = 0;
  for (const segment of segments) {
    totalWidth += measureTextSegment(
      segment,
      fontSize,
      baseFontWeight,
      fontFamily,
      codePadding
    );
  }
  return totalWidth;
};

// Measure width of formatted text up to a specific character position
// This is used for cursor positioning
// This matches how renderFormattedLine advances currentX after each segment
export const measureFormattedTextUpToIndex = (
  segments: Text[],
  startIndex: number,
  endIndex: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  codePadding: number = 0
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
      overlapEnd - segmentStart
    );

    const effectiveFontWeight = segment.formats?.some((f) => f.type === "bold")
      ? "bold"
      : baseFontWeight;

    let segmentWidth = measureText(
      textToMeasure,
      fontSize,
      effectiveFontWeight,
      fontFamily
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

// Wrap formatted text (Text[]) to lines
export const wrapFormattedText = (
  segments: Text[],
  maxWidth: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  codePadding: number = 0
): string[] => {
  // Convert segments to plain text for wrapping
  const fullText = segments.map((s) => s.content).join("");

  // Build a character-to-segment map for accurate measurement
  const charToSegment: number[] = [];
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    for (let i = 0; i < segments[segIdx].content.length; i++) {
      charToSegment.push(segIdx);
    }
  }

  const lines: string[] = [];
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
      codePadding
    );
  };

  // Measure space with base weight
  const spaceWidth = measureText(" ", fontSize, baseFontWeight, fontFamily);

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const wordStart = currentCharIndex;
    const wordEnd = currentCharIndex + word.length;
    const wordWidth = measureSubstring(wordStart, wordEnd);

    // Calculate space needed for this word including preceding space if line not empty
    const spaceIfNeeded = currentLine ? spaceWidth : 0;

    if (currentLineWidth + spaceIfNeeded + wordWidth <= maxWidth) {
      // Fits on current line
      currentLine = currentLine ? currentLine + " " + word : word;
      currentLineWidth += spaceIfNeeded + wordWidth;
      currentCharIndex = wordEnd + (i < words.length - 1 ? 1 : 0); // +1 for space
    } else {
      // Does not fit. Push current line if it has content.
      if (currentLine) {
        lines.push(currentLine);
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
            const charWidth = measureText(
              fullText[j],
              fontSize,
              fontWeight,
              fontFamily
            );

            if (currentWidth + charWidth > maxWidth && j > remainingWordStart) {
              splitIndex = j;
              break;
            }
            currentWidth += charWidth;
            splitIndex = j + 1;
          }

          if (splitIndex === remainingWordStart) splitIndex++;

          const chunk = fullText.substring(remainingWordStart, splitIndex);
          lines.push(chunk);
          remainingWordStart = splitIndex;
        }

        currentLine = "";
        currentLineWidth = 0;
        currentCharIndex = wordEnd + (i < words.length - 1 ? 1 : 0);
      }
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [""];
};

// Global font configuration - can be changed at runtime
let globalFontConfig: FontConfig = {
  fontFamily: "poppins",
};

// Get the current font family
export const getCurrentFontFamily = (): FontFamily =>
  globalFontConfig.fontFamily;

// Initialize cache immediately
if (typeof window !== "undefined") {
  // Wait for fonts to load before initializing metrics cache
  loadFonts().then(() => {
    try {
      initializeCache();
    } catch (error) {
      console.warn("Text measurement cache initialization failed:", error);
    }
  });
}
