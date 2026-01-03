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

export interface Image {
  id: string; // Unique identifier for caching
  type: "image";
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  cachedHeight?: number; // Cached rendered height
  cachedWidth?: number; // Width at which height was cached
  uploadStatus?: 'uploading' | 'complete' | 'error';
  file?: File; // Temporary file during upload
}

export interface TextFormat {
  type: 'bold' | 'italic' | 'strikethrough' | 'code' | 'link';
  url?: string; // Only for link type
}

export interface Text {
  content: string;
  formats?: TextFormat[];
}

// Helper function to compare two TextFormat objects
export function areFormatsEqual(a: TextFormat, b: TextFormat): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'link' && b.type === 'link') {
    return a.url === b.url;
  }
  return true;
}

// Helper function to compare two arrays of TextFormat objects
export function areFormatArraysEqual(a: TextFormat[] | undefined, b: TextFormat[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  
  // Sort both arrays by type for consistent comparison
  const sortedA = [...a].sort((x, y) => x.type.localeCompare(y.type));
  const sortedB = [...b].sort((x, y) => x.type.localeCompare(y.type));
  
  for (let i = 0; i < sortedA.length; i++) {
    if (!areFormatsEqual(sortedA[i], sortedB[i])) {
      return false;
    }
  }
  
  return true;
}

// Text blocks contain text content
export type TextBlock = Heading | Paragraph;

// Visual blocks contain visual content (images, etc.)
export type VisualBlock = Image;

// Block is a union of all block types
export type Block = TextBlock | VisualBlock;

// Type guards
export function isTextBlock(block: Block): block is TextBlock {
  return block.type !== "image";
}

export function isVisualBlock(block: Block): block is VisualBlock {
  return block.type === "image";
}

// Legacy alias for backward compatibility
export function isImageBlock(block: Block): block is Image {
  return block.type === "image";
}

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
