/**
 * RTL (Right-to-Left) text handling utilities
 * Provides functions to detect and handle RTL languages like Arabic, Hebrew, Persian, etc.
 */

import type { Text } from "../deserializer/loadPage";

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
export function getTextDirection(text: string): "rtl" | "ltr" {
  if (!text || text.length === 0) return "ltr";
  
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
  if (totalDirectional === 0) return "ltr";
  
  return rtlCount / totalDirectional > 0.3 ? "rtl" : "ltr";
}

/**
 * Get the direction of a text segment
 */
export function getSegmentDirection(segment: Text): "rtl" | "ltr" {
  return getTextDirection(segment.content);
}

/**
 * Get the direction of an array of text segments (formatted text)
 * Returns the direction based on the first segment with directional content
 */
export function getFormattedTextDirection(segments: Text[]): "rtl" | "ltr" {
  if (!segments || segments.length === 0) return "ltr";
  
  let totalRtl = 0;
  let totalLtr = 0;
  
  for (const segment of segments) {
    const content = segment.content;
    for (const char of content) {
      if (isRTLChar(char)) {
        totalRtl++;
      } else if (/[a-zA-Z]/.test(char)) {
        totalLtr++;
      }
    }
  }
  
  const totalDirectional = totalRtl + totalLtr;
  if (totalDirectional === 0) return "ltr";
  
  return totalRtl / totalDirectional > 0.3 ? "rtl" : "ltr";
}

/**
 * Split text segments by direction changes
 * This helps render mixed LTR/RTL text correctly
 */
export interface DirectionalSegment {
  segment: Text;
  direction: "rtl" | "ltr";
  startIndex: number;
  endIndex: number;
}

/**
 * Analyze text segments and return directional segments
 */
export function analyzeTextDirectionality(segments: Text[]): DirectionalSegment[] {
  const result: DirectionalSegment[] = [];
  let currentIndex = 0;
  
  for (const segment of segments) {
    const direction = getSegmentDirection(segment);
    result.push({
      segment,
      direction,
      startIndex: currentIndex,
      endIndex: currentIndex + segment.content.length,
    });
    currentIndex += segment.content.length;
  }
  
  return result;
}

/**
 * Check if a position within text is in an RTL segment
 */
export function isPositionInRTL(
  segments: Text[],
  textIndex: number
): boolean {
  let currentIndex = 0;
  
  for (const segment of segments) {
    const segmentStart = currentIndex;
    const segmentEnd = currentIndex + segment.content.length;
    
    if (textIndex >= segmentStart && textIndex < segmentEnd) {
      return getSegmentDirection(segment) === "rtl";
    }
    
    currentIndex = segmentEnd;
  }
  
  return false;
}

/**
 * Get the direction at a specific character position
 */
export function getDirectionAtPosition(
  segments: Text[],
  textIndex: number
): "rtl" | "ltr" {
  let currentIndex = 0;
  
  for (const segment of segments) {
    const segmentStart = currentIndex;
    const segmentEnd = currentIndex + segment.content.length;
    
    if (textIndex >= segmentStart && textIndex <= segmentEnd) {
      // If at segment boundary, check the character
      if (textIndex === segmentEnd && textIndex < getTotalLength(segments)) {
        // Check next segment
        continue;
      }
      return getSegmentDirection(segment);
    }
    
    currentIndex = segmentEnd;
  }
  
  return "ltr";
}

/**
 * Helper to get total length of formatted text
 */
function getTotalLength(segments: Text[]): number {
  return segments.reduce((sum, seg) => sum + seg.content.length, 0);
}

/**
 * Check if cursor movement should be visually reversed for RTL
 * This can be used to implement visual navigation in RTL text
 * For now, we use logical navigation (left=backward, right=forward)
 * regardless of text direction
 */
export function shouldReverseArrowKeys(_segments: Text[]): boolean {
  // For visual navigation, return true if RTL
  // For logical navigation, return false
  // Currently using logical navigation
  return false;
  
  // Uncomment below for visual navigation:
  // return getFormattedTextDirection(segments) === "rtl";
}
