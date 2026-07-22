/** Rough word count from a Markdown string — strips the lightest syntax noise. */
export function countWords(markdown: string): number {
  const text = markdown
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/[#>*_~`>-]/g, " ") // stray markdown punctuation
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // link → its label
  const matches = text.trim().match(/[^\s]+/g);
  return matches ? matches.length : 0;
}

/** mm:ss formatter for the session clock. */
export function clock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
