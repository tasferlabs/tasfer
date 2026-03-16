/**
 * RTL (Right-to-Left) text handling utilities
 * Provides functions to detect and handle RTL languages like Arabic, Hebrew, Persian, etc.
 */

import i18next from "i18next";
import type { Char } from "../deserializer/loadPage";

/**
 * Unicode ranges for RTL scripts
 * Based on Unicode standard for strong RTL characters
 */
const RTL_RANGES = [
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0700, 0x074f], // Syriac
  [0x0750, 0x077f], // Arabic Supplement
  [0x0780, 0x07bf], // Thaana
  [0x07c0, 0x07ff], // NKo
  [0x0800, 0x083f], // Samaritan
  [0x0840, 0x085f], // Mandaic
  [0x08a0, 0x08ff], // Arabic Extended-A
  [0xfb1d, 0xfb4f], // Hebrew presentation forms
  [0xfb50, 0xfdff], // Arabic presentation forms A
  [0xfe70, 0xfeff], // Arabic presentation forms B
];

/**
 * Check if a character is an RTL character
 */
export function isRTLChar(char: string): boolean {
  if (!char || char.length === 0) return false;
  const code = char.charCodeAt(0);

  for (const [start, end] of RTL_RANGES) {
    if (code >= start && code <= end) {
      return true;
    }
  }

  return false;
}

/**
 * Detect the dominant text direction of a string
 * Returns 'rtl' if the text is predominantly RTL, 'ltr' otherwise
 */
/**
 * Get the default text direction based on the current app language.
 */
function getDefaultDirection(): "rtl" | "ltr" {
  return (i18next.dir() as "rtl" | "ltr") || "ltr";
}

export function getTextDirection(text: string): "rtl" | "ltr" {
  if (!text || text.length === 0) return getDefaultDirection();

  let rtlCount = 0;
  let ltrCount = 0;

  for (const char of text) {
    if (isRTLChar(char)) {
      rtlCount++;
    } else if (/[a-zA-Z]/.test(char)) {
      // Count Latin letters as LTR
      ltrCount++;
    }
  }

  // If more than 30% of directional characters are RTL, treat as RTL
  const totalDirectional = rtlCount + ltrCount;
  if (totalDirectional === 0) return getDefaultDirection();

  return rtlCount / totalDirectional > 0.3 ? "rtl" : "ltr";
}

/**
 * Get the direction of char array (CRDT-based)
 * Returns the direction based on the visible characters
 */
export function getCharsDirection(chars: Char[]): "rtl" | "ltr" {
  if (!chars || chars.length === 0) return getDefaultDirection();

  // Get visible text from chars
  const text = chars
    .filter((c) => !c.deleted)
    .map((c) => c.char)
    .join("");
  return getTextDirection(text);
}
