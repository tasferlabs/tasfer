import parsePage from "./parser";
import tokenizePage from "./tokenizer";

export interface Heading {
  id: string; // Unique identifier for caching
  type: "heading1" | "heading2" | "heading3";
  content: Text[];
  cachedHeight?: number; // Cached rendered height
  cachedWidth?: number; // Width at which height was cached
}
export interface Paragraph {
  id: string; // Unique identifier for caching
  type: "paragraph";
  content: Text[];
  cachedHeight?: number; // Cached rendered height
  cachedWidth?: number; // Width at which height was cached
}

export interface Text {
  content: string;
  format?: string;
}

export type Block = Heading | Paragraph;

export interface Page {
  title: String;
  // color: string;
  // icon: string;
  blocks: Block[];
}

export function loadPage(content: string): Page {
  const tokens = tokenizePage(content);
  const page = parsePage(tokens);
  return page;
}
