/**
 * Markdown parser — orchestrator only.
 *
 * Per-block-type parsing lives in the block codecs (./codecs): each codec
 * declares which block-start tokens (and HTML tag names) it claims, and this
 * file dispatches to it with an `InputCtx` token-cursor view. The parser owns
 * what is genuinely cross-block: tokenization order, indent consumption,
 * empty-line blocks, id generation, inline text → CRDT runs, and afterId
 * chaining.
 */

import { baseDataSchema } from "../baseDataSchema";
import { extractCounter, extractPeerId } from "../sync/id";
import type { DataSchema } from "../sync/schema";
import type { InputCtx, ParsedTag } from "./codecs";
import type { Block, Char, CharRun, Mark, MarkSpan, Page } from "./loadPage";
import { markKey } from "./loadPage";
import {
  HTML_TAG,
  INDENT,
  LINK_END,
  LINK_START,
  LINK_TEXT_END,
  NEWLINE,
  type Token,
  type TokenType,
  type VisibleToken,
} from "./tokenizer";

interface ParserContext {
  tokens: Token[];
  current: number;
  blockIdCounter: number; // Counter for generating unique block IDs
  charIdCounter: number; // Counter for generating unique char IDs
  schema: DataSchema; // Block/mark types in play (codec dispatch source)
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

export default function parsePage(
  tokens: Token[],
  schema: DataSchema = baseDataSchema,
): Page {
  const tree = generateEmptyTree();

  const context: ParserContext = {
    tokens,
    current: 0,
    blockIdCounter: 0,
    charIdCounter: 0,
    schema,
  };

  while (!isEnd(context)) {
    const block = parseBlock(context);
    tree.blocks.push(block);
  }

  // Ensure at least one block exists (empty paragraph for empty files)
  if (tree.blocks.length === 0) {
    tree.blocks.push(emptyBlock(context));
  }

  // Chain blocks via afterId so the CRDT linked-list order matches parse
  // order. resolveBlockOrder reconstructs the block array from these links on
  // every block_insert; without them all loaded blocks anchor at null and get
  // re-sorted by id, scrambling the document on the first split/insert.
  let prevBlockId: string | null = null;
  for (const block of tree.blocks) {
    block.afterId = prevBlockId;
    prevBlockId = block.id;
  }

  return tree;
}

function isEnd(context: ParserContext) {
  return context.tokens.length <= context.current;
}

/** Token-cursor view of this parser handed to codec input functions. */
function makeInputCtx(context: ParserContext, indent: number): InputCtx {
  return {
    indent,
    nextBlockId: () => `block-${context.blockIdCounter++}`,
    inlineText: () => {
      const { chars, formats } = parseCharsAndFormats(context);
      return { charRuns: charsToRuns(chars), formats };
    },
    rawText: (text: string) => {
      const chars: Char[] = [];
      for (const char of text) {
        chars.push({ id: generateCharId(context), char, deleted: false });
      }
      return charsToRuns(chars);
    },
    match: (...types: TokenType[]) => match(context, ...types),
    check: (type: TokenType) => check(context, type),
    advance: () => advance(context),
    previous: () => previous(context),
    peek: () => peek(context),
    isEnd: () => isEnd(context),
  };
}

/** Parse `<tag attr="value" ... />` into name + attribute map. */
function parseHtmlTag(raw: string): ParsedTag {
  const nameMatch = /^<\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
  const name = nameMatch ? nameMatch[1].toLowerCase() : "";

  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(raw)) !== null) {
    attrs[attrMatch[1].toLowerCase()] = attrMatch[2];
  }

  return { name, attrs, raw };
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

  const ctx = makeInputCtx(context, indent);

  // HTML tags at block start: dispatch by tag name; unknown tags fall
  // through to the paragraph fallback, which keeps them as literal text.
  if (check(context, HTML_TAG)) {
    const tag = parseHtmlTag((peek(context) as VisibleToken).content);
    const codec = context.schema.htmlTagDispatch.get(tag.name);
    if (codec?.markdown.inputTag) {
      advance(context); // Consume the tag token; inputTag gets the parsed form
      return codec.markdown.inputTag(tag, ctx);
    }
  }

  // Block-start tokens: dispatch to the codec that claims them. Codecs
  // consume their own trigger token.
  if (!isEnd(context)) {
    const codec = context.schema.tokenDispatch.get(peek(context).type);
    if (codec?.markdown.input) {
      return codec.markdown.input(ctx);
    }
  }

  // Everything else parses as paragraph text.
  return context.schema.getFallbackCodec()!.markdown.input!(ctx);
}

function emptyBlock(context: ParserContext): Block {
  return {
    id: `block-${context.blockIdCounter++}`,
    type: "paragraph",
    charRuns: [],
    formats: [],
  };
}

// Parse text into Char[] and MarkSpan[] (CRDT native format)
function parseCharsAndFormats(context: ParserContext): {
  chars: Char[];
  formats: MarkSpan[];
} {
  const chars: Char[] = [];
  const formats: MarkSpan[] = [];
  const formatStack: Mark[] = [];
  const activeMarks: Map<string, { format: Mark; startCharId: string }> =
    new Map();
  // Links can't ride the formatStack: their text chars are created before the
  // url token arrives (at LINK_TEXT_END), so the span is emitted directly at
  // LINK_END over the chars created since LINK_START.
  let pendingLink: { startCharIndex: number; url: string } | null = null;

  while (!isEnd(context) && nomatch(context, NEWLINE)) {
    const node = previous(context) as VisibleToken;

    // Inline mark open/close tokens are data-driven: each mark declares its
    // paired tokenizer tokens via its codec (MarkCodec.tokens), so the parser
    // dispatches token → mark type through the schema instead of a per-mark
    // if-chain. Links are parsed specially (their url arrives after the text),
    // so they stay out of the token table and are handled below.
    const markStart = context.schema.markTypeForStartToken(node.type);
    const markEnd = context.schema.markTypeForEndToken(node.type);
    if (markStart) {
      formatStack.push({ type: markStart });
    } else if (markEnd) {
      const index = formatStack.findIndex((f) => f.type === markEnd);
      if (index !== -1) formatStack.splice(index, 1);
    } else if (node.type === LINK_START) {
      // Link text chars start here; the url arrives at LINK_TEXT_END
      pendingLink = { startCharIndex: chars.length, url: "" };
    } else if (node.type === LINK_TEXT_END) {
      // Collect URL from next TEXT token
      if (!isEnd(context)) {
        const nextToken = peek(context);
        if (nextToken.type === "text") {
          advance(context);
          const linkUrl = (previous(context) as VisibleToken).content;
          if (pendingLink) pendingLink.url = linkUrl;
        }
      }
    } else if (node.type === LINK_END) {
      // Emit the span over the link-text chars
      if (
        pendingLink &&
        pendingLink.url &&
        chars.length > pendingLink.startCharIndex
      ) {
        formats.push({
          startCharId: chars[pendingLink.startCharIndex].id,
          endCharId: chars[chars.length - 1].id,
          format: { type: "link", attrs: { url: pendingLink.url } },
          clock: { counter: 0, peerId: "parser" },
        });
      }
      pendingLink = null;
    }
    // Handle text content - create chars
    else if (node.content) {
      for (const char of node.content) {
        const charId = generateCharId(context);
        chars.push({ id: charId, char, deleted: false });

        // Create format spans for active formats
        for (const format of formatStack) {
          const formatKey = markKey(format);
          if (!activeMarks.has(formatKey)) {
            activeMarks.set(formatKey, { format, startCharId: charId });
          }
        }

        // Close formats that are no longer active
        for (const [key, active] of activeMarks.entries()) {
          const stillActive = formatStack.some((f) => markKey(f) === key);
          if (!stillActive) {
            // This format ended - create a span
            formats.push({
              startCharId: active.startCharId,
              endCharId: chars[chars.length - 2]?.id || active.startCharId,
              format: active.format,
              clock: { counter: 0, peerId: "parser" },
            });
            activeMarks.delete(key);
          }
        }
      }
    }
  }

  // Close any remaining active formats
  if (chars.length > 0) {
    for (const [_, active] of activeMarks.entries()) {
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
