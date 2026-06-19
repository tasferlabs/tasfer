/** A live document-outline entry parsed from Markdown headings. */
export interface OutlineItem {
  level: 1 | 2 | 3;
  text: string;
}

/** Rough word count from a Markdown string — strips the lightest syntax noise. */
export function countWords(markdown: string): number {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/[#>*_~`-]/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // link → its label
  const matches = text.trim().match(/[^\s]+/g);
  return matches ? matches.length : 0;
}

/** Parse the heading outline (H1–H3) from a Markdown string, in document order. */
export function parseOutline(markdown: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,3})\s+(.*\S)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length as 1 | 2 | 3, text: m[2].replace(/[*_`]/g, "") });
  }
  return out;
}
