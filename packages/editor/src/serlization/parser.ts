import type { Image } from "../rendering/blocks/ImageBlockView";
import type { Line } from "../rendering/blocks/LineBlockView";
import type {
  BulletListItem,
  NumberedListItem,
  TodoListItem,
} from "../rendering/blocks/ListBlockView";
import type { MathBlock } from "../rendering/blocks/MathBlockView";
import type { Heading, Paragraph } from "../rendering/blocks/TextBlockView";
import { extractCounter, extractPeerId } from "../sync/id";
import type {
  Block,
  Char,
  CharRun,
  FormatSpan,
  Page,
  TextFormat,
} from "./loadPage";
import {
  BOLD_END,
  BOLD_START,
  BULLET_LIST,
  CODE_END,
  CODE_START,
  HEADING_1,
  HEADING_2,
  HEADING_3,
  HORIZONTAL_RULE,
  HTML_IMG,
  IMAGE_ALT_END,
  IMAGE_END,
  IMAGE_START,
  INDENT,
  INLINE_MATH_END,
  INLINE_MATH_START,
  ITALIC_END,
  ITALIC_START,
  LINK_END,
  LINK_START,
  LINK_TEXT_END,
  MATH_BLOCK,
  NEWLINE,
  NUMBERED_LIST,
  STRIKETHROUGH_END,
  STRIKETHROUGH_START,
  TEXT,
  TODO_LIST_CHECKED,
  TODO_LIST_UNCHECKED,
  type Token,
  type TokenType,
  type VisibleToken,
} from "./tokenizer";

interface ParserContext {
  tokens: Token[];
  current: number;
  blockIdCounter: number; // Counter for generating unique block IDs
  charIdCounter: number; // Counter for generating unique char IDs
}

// Generate a unique char ID.
// Use compound `${peerId}:${counter}` form so the ID survives a
// `charsToRuns` → `iterateVisibleChars` round-trip (which always rebuilds
// IDs as `${run.peerId}:${run.startCounter + offset}`). With a single
// shared peerId and a sequential counter, all chars coalesce into one run
// and the IDs stored in format spans keep matching runtime char IDs.
function generateCharId(context: ParserContext): string {
  return `init:${context.charIdCounter++}`;
}

/**
 * Convert Char[] to CharRun[] for efficient storage.
 * Groups consecutive characters from the same peer into runs.
 */
function charsToRuns(chars: Char[]): CharRun[] {
  if (chars.length === 0) return [];

  const runs: CharRun[] = [];
  let currentPeerId = extractPeerId(chars[0].id);
  let currentStartCounter = extractCounter(chars[0].id);
  let currentText = "";
  let currentDeletedMask: number[] | undefined = undefined;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const peerId = extractPeerId(char.id);
    const counter = extractCounter(char.id);

    // Check if this char continues the current run
    const expectedCounter = currentStartCounter + currentText.length;
    if (peerId === currentPeerId && counter === expectedCounter) {
      currentText += char.char;

      // Update deletion mask if needed
      if (char.deleted) {
        if (!currentDeletedMask) {
          const requiredBytes = Math.ceil(currentText.length / 8);
          currentDeletedMask = new Array(requiredBytes).fill(0);
        } else if (currentText.length > currentDeletedMask.length * 8) {
          // Expand mask if needed
          const requiredBytes = Math.ceil(currentText.length / 8);
          const newMask = new Array(requiredBytes).fill(0);
          for (let j = 0; j < currentDeletedMask.length; j++) {
            newMask[j] = currentDeletedMask[j];
          }
          currentDeletedMask = newMask;
        }
        const offset = currentText.length - 1;
        const byteIndex = Math.floor(offset / 8);
        const bitIndex = offset % 8;
        currentDeletedMask[byteIndex] |= 1 << bitIndex;
      }
    } else {
      // Save current run if non-empty
      if (currentText.length > 0) {
        runs.push({
          peerId: currentPeerId,
          startCounter: currentStartCounter,
          text: currentText,
          deletedMask: currentDeletedMask,
        });
      }
      // Start new run
      currentPeerId = peerId;
      currentStartCounter = counter;
      currentText = char.char;
      if (char.deleted) {
        currentDeletedMask = [1]; // First char is deleted
      } else {
        currentDeletedMask = undefined;
      }
    }
  }

  // Save final run
  if (currentText.length > 0) {
    runs.push({
      peerId: currentPeerId,
      startCounter: currentStartCounter,
      text: currentText,
      deletedMask: currentDeletedMask,
    });
  }

  return runs;
}

function generateEmptyTree(): Page {
  return {
    id: "default-page",
    title: "",
    blocks: [],
  };
}
function generateHeading(
  id: string,
  level: number,
  chars: Char[],
  formats: FormatSpan[],
): Heading {
  return {
    id,
    type: ("heading" + level) as "heading1" | "heading2" | "heading3",
    charRuns: charsToRuns(chars),
    formats,
  };
}

export default function parsePage(tokens: Token[]): Page {
  const tree = generateEmptyTree();

  const context: ParserContext = {
    tokens,
    current: 0,
    blockIdCounter: 0,
    charIdCounter: 0,
  };

  // paresTitle(context);

  while (!isEnd(context)) {
    const block = parseBlock(context);
    tree.blocks.push(block);
  }

  // Ensure at least one block exists (empty paragraph for empty files)
  if (tree.blocks.length === 0) {
    tree.blocks.push(emptyBlock(context));
  }

  return tree;
}
function isEnd(context: ParserContext) {
  return context.tokens.length <= context.current;
}
function parseBlock(context: ParserContext): Block {
  if (match(context, NEWLINE)) return emptyBlock(context);

  // Check for indentation first
  let indent = 0;
  if (check(context, INDENT)) {
    advance(context);
    const indentToken = previous(context) as VisibleToken;
    // Calculate indent level (2 spaces = 1 level)
    indent = Math.floor(indentToken.content.length / 2);
  }

  // Check for list blocks
  if (check(context, BULLET_LIST)) return parseBulletListItem(context, indent);
  if (check(context, NUMBERED_LIST))
    return parseNumberedListItem(context, indent);
  if (check(context, TODO_LIST_UNCHECKED))
    return parseTodoListItem(context, indent, false);
  if (check(context, TODO_LIST_CHECKED))
    return parseTodoListItem(context, indent, true);

  // Check for other block types
  if (check(context, HORIZONTAL_RULE)) return parseHorizontalRule(context);
  if (check(context, MATH_BLOCK)) return parseMathBlock(context);
  if (check(context, HTML_IMG)) return parseHTMLImage(context);
  if (check(context, IMAGE_START)) return parseImage(context);
  if (match(context, HEADING_1)) return parseHeading(context, 1);
  if (match(context, HEADING_2)) return parseHeading(context, 2);
  if (match(context, HEADING_3)) return parseHeading(context, 3);
  return paresParagraph(context);
}
function emptyBlock(context: ParserContext): Block {
  return {
    id: `block-${context.blockIdCounter++}`,
    type: "paragraph",
    charRuns: [],
    formats: [],
  };
}
function parseHeading(context: ParserContext, level: number) {
  const { chars, formats } = parseCharsAndFormats(context);
  const heading = generateHeading(
    `block-${context.blockIdCounter++}`,
    level,
    chars,
    formats,
  );
  match(context, NEWLINE);
  return heading;
}
// Parse text into Char[] and FormatSpan[] (CRDT native format)
function parseCharsAndFormats(context: ParserContext): {
  chars: Char[];
  formats: FormatSpan[];
} {
  const chars: Char[] = [];
  const formats: FormatSpan[] = [];
  const formatStack: TextFormat[] = [];
  const activeFormats: Map<
    string,
    { format: TextFormat; startCharId: string }
  > = new Map();

  while (!isEnd(context) && nomatch(context, NEWLINE)) {
    const node = previous(context) as VisibleToken;

    // Handle format start tokens
    if (node.type === BOLD_START) {
      formatStack.push({ type: "bold" });
    } else if (node.type === ITALIC_START) {
      formatStack.push({ type: "italic" });
    } else if (node.type === STRIKETHROUGH_START) {
      formatStack.push({ type: "strikethrough" });
    } else if (node.type === CODE_START) {
      formatStack.push({ type: "code" });
    } else if (node.type === INLINE_MATH_START) {
      formatStack.push({ type: "math" });
    } else if (node.type === INLINE_MATH_END) {
      const index = formatStack.findIndex((f) => f.type === "math");
      if (index !== -1) formatStack.splice(index, 1);
    } else if (node.type === LINK_START) {
      // Start collecting link text
    } else if (node.type === LINK_TEXT_END) {
      // Collect URL from next TEXT token
      let linkUrl = "";
      if (!isEnd(context)) {
        const nextToken = peek(context);
        if (nextToken.type === "text") {
          advance(context);
          linkUrl = (previous(context) as VisibleToken).content;
        }
      }
      formatStack.push({ type: "link", url: linkUrl });
    } else if (node.type === LINK_END) {
      // Link has ended - the format will be removed when we see the next format end or text end
      const index = formatStack.findIndex((f) => f.type === "link");
      if (index !== -1) formatStack.splice(index, 1);
    }
    // Handle format end tokens
    else if (node.type === BOLD_END) {
      const index = formatStack.findIndex((f) => f.type === "bold");
      if (index !== -1) formatStack.splice(index, 1);
    } else if (node.type === ITALIC_END) {
      const index = formatStack.findIndex((f) => f.type === "italic");
      if (index !== -1) formatStack.splice(index, 1);
    } else if (node.type === STRIKETHROUGH_END) {
      const index = formatStack.findIndex((f) => f.type === "strikethrough");
      if (index !== -1) formatStack.splice(index, 1);
    } else if (node.type === CODE_END) {
      const index = formatStack.findIndex((f) => f.type === "code");
      if (index !== -1) formatStack.splice(index, 1);
    }
    // Handle text content - create chars
    else if (node.content) {
      for (const char of node.content) {
        const charId = generateCharId(context);
        chars.push({ id: charId, char, deleted: false });

        // Create format spans for active formats
        for (const format of formatStack) {
          const formatKey = format.type + (format.url || "");
          if (!activeFormats.has(formatKey)) {
            activeFormats.set(formatKey, { format, startCharId: charId });
          }
        }

        // Close formats that are no longer active
        for (const [key, active] of activeFormats.entries()) {
          const stillActive = formatStack.some(
            (f) => f.type + (f.url || "") === key,
          );
          if (!stillActive) {
            // This format ended - create a span
            formats.push({
              startCharId: active.startCharId,
              endCharId: chars[chars.length - 2]?.id || active.startCharId,
              format: active.format,
              clock: { counter: 0, peerId: "parser" },
            });
            activeFormats.delete(key);
          }
        }
      }
    }
  }

  // Close any remaining active formats
  if (chars.length > 0) {
    for (const [_, active] of activeFormats.entries()) {
      formats.push({
        startCharId: active.startCharId,
        endCharId: chars[chars.length - 1].id,
        format: active.format,
        clock: { counter: 0, peerId: "parser" },
      });
    }
  }

  advance(context);
  return { chars, formats };
}

function paresParagraph(context: ParserContext): Paragraph {
  const { chars, formats } = parseCharsAndFormats(context);
  return {
    id: `block-${context.blockIdCounter++}`,
    type: "paragraph",
    charRuns: charsToRuns(chars),
    formats,
  };
}

function parseBulletListItem(
  context: ParserContext,
  indent: number,
): BulletListItem {
  match(context, BULLET_LIST); // Consume the bullet marker
  const { chars, formats } = parseCharsAndFormats(context);
  return {
    id: `block-${context.blockIdCounter++}`,
    type: "bullet_list",
    charRuns: charsToRuns(chars),
    formats,
    indent,
  };
}

function parseNumberedListItem(
  context: ParserContext,
  indent: number,
): NumberedListItem {
  match(context, NUMBERED_LIST); // Consume the numbered marker
  const { chars, formats } = parseCharsAndFormats(context);
  return {
    id: `block-${context.blockIdCounter++}`,
    type: "numbered_list",
    charRuns: charsToRuns(chars),
    formats,
    indent,
  };
}

function parseTodoListItem(
  context: ParserContext,
  indent: number,
  checked: boolean,
): TodoListItem {
  // Consume the todo marker (either TODO_LIST_UNCHECKED or TODO_LIST_CHECKED)
  if (checked) {
    match(context, TODO_LIST_CHECKED);
  } else {
    match(context, TODO_LIST_UNCHECKED);
  }
  const { chars, formats } = parseCharsAndFormats(context);
  return {
    id: `block-${context.blockIdCounter++}`,
    type: "todo_list",
    charRuns: charsToRuns(chars),
    formats,
    checked,
    indent,
  };
}

function parseHorizontalRule(context: ParserContext): Line {
  match(context, HORIZONTAL_RULE); // Consume the horizontal rule token
  match(context, NEWLINE); // Consume optional newline

  return {
    id: `block-${context.blockIdCounter++}`,
    type: "line",
  };
}

function parseMathBlock(context: ParserContext): MathBlock {
  match(context, MATH_BLOCK);
  const latex = (previous(context) as VisibleToken).content;
  match(context, NEWLINE);

  return {
    id: `block-${context.blockIdCounter++}`,
    type: "math",
    latex,
    displayMode: true,
  };
}

function parseImage(context: ParserContext): Image {
  // ![alt](url)
  match(context, IMAGE_START); // Consume ![

  let altText = "";
  let imageUrl = "";

  // Get alt text
  if (!isEnd(context) && check(context, TEXT)) {
    advance(context);
    altText = (previous(context) as VisibleToken).content;
  }

  // Consume ](
  match(context, IMAGE_ALT_END);

  // Get URL
  if (!isEnd(context) && check(context, TEXT)) {
    advance(context);
    imageUrl = (previous(context) as VisibleToken).content;
  }

  // Consume )
  match(context, IMAGE_END);

  // Consume optional newline
  match(context, NEWLINE);

  return {
    id: `block-${context.blockIdCounter++}`,
    type: "image",
    url: imageUrl,
    alt: altText,
    // Default properties - not specified in markdown
  };
}

function parseHTMLImage(context: ParserContext): Image {
  // <img src="url" alt="alt" width="..." height="..." data-object-fit="..." />
  match(context, HTML_IMG);
  const htmlTag = (previous(context) as VisibleToken).content;

  // Parse attributes from HTML tag
  const srcMatch = /src="([^"]+)"/.exec(htmlTag);
  const altMatch = /alt="([^"]*)"/.exec(htmlTag);
  const widthMatch = /(?:width|data-width)="([^"]+)"/.exec(htmlTag);
  const heightMatch = /height="([^"]+)"/.exec(htmlTag);
  const objectFitMatch = /data-object-fit="([^"]+)"/.exec(htmlTag);

  const imageUrl = srcMatch ? srcMatch[1] : "";
  const altText = altMatch ? altMatch[1] : "";
  const width = widthMatch
    ? widthMatch[1] === "full"
      ? "full"
      : parseInt(widthMatch[1], 10)
    : undefined;
  const height = heightMatch ? parseInt(heightMatch[1], 10) : undefined;
  const objectFit = objectFitMatch
    ? (objectFitMatch[1] as "cover" | "contain")
    : undefined;

  // Consume optional newline
  match(context, NEWLINE);

  return {
    id: `block-${context.blockIdCounter++}`,
    type: "image",
    url: imageUrl,
    alt: altText,
    width,
    height,
    objectFit,
  };
}

function match(context: ParserContext, ...types: TokenType[]): boolean {
  for (const type of types) {
    if (check(context, type)) {
      advance(context);
      return true;
    }
  }

  return false;
}
function nomatch(context: ParserContext, ...types: TokenType[]): boolean {
  for (const type of types) {
    if (!check(context, type)) {
      advance(context);
      return true;
    }
  }

  return false;
}

function advance(context: ParserContext): Token {
  if (!isEnd(context)) context.current++;
  return previous(context);
}

function previous(context: ParserContext): Token {
  return context.tokens[context.current - 1];
}
function check(context: ParserContext, type: string) {
  if (isEnd(context)) return false;
  return peek(context).type == type;
}
function peek(context: ParserContext) {
  return context.tokens[context.current];
}
