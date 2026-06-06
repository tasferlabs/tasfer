// Helper function to check if a character is CJK (Chinese, Japanese, Korean)
// Exported for use in word boundary detection
export function isCJKCharacter(char: string): boolean {
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
}
// Helper function to check if text contains CJK characters
export function containsCJK(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isCJKCharacter(text[i])) {
      return true;
    }
  }
  return false;
}
