import type { Block, Heading, Page, Paragraph, Text, TextFormat } from "./loadPage";
import {
  BOLD_END,
  BOLD_START,
  CODE_END,
  CODE_START,
  HEADING_1,
  HEADING_2,
  HEADING_3,
  ITALIC_END,
  ITALIC_START,
  NEWLINE,
  STRIKETHROUGH_END,
  STRIKETHROUGH_START,
  type Token,
  type TokenType,
  type VisibleToken,
} from "./tokenizer";

interface ParserContext {
  tokens: Token[];
  current: number;
  blockIdCounter: number; // Counter for generating unique block IDs
}

function generateEmptyTree(): Page {
  return {
    title: "",
    blocks: [],
  };
}
function generateHeading(id: string, level: number, ...content: Text[]): Heading {
  return {
    id,
    type: ("heading" + level) as "heading1" | "heading2" | "heading3",
    content: content || [],
  };
}

export default function parsePage(tokens: Token[]): Page {
  const tree = generateEmptyTree();

  const context: ParserContext = {
    tokens,
    current: 0,
    blockIdCounter: 0,
  };

  // paresTitle(context);

  while (!isEnd(context)) {
    const block = parseBlock(context);
    tree.blocks.push(block);
  }

  return tree;
}
function isEnd(context: ParserContext) {
  return context.tokens.length <= context.current;
}
function parseBlock(context: ParserContext): Block {
  if (match(context, NEWLINE)) return emptyBlock(context);
  if (match(context, HEADING_1)) return parseHeading(context, 1);
  if (match(context, HEADING_2)) return parseHeading(context, 2);
  if (match(context, HEADING_3)) return parseHeading(context, 3);
  return paresParagraph(context);
}
function emptyBlock(context: ParserContext): Block {
  return {
    id: `block-${context.blockIdCounter++}`,
    type: "paragraph",
    content: [],
  };
}
function parseHeading(context: ParserContext, level: number) {
  const content = parseText(context);
  const heading = generateHeading(`block-${context.blockIdCounter++}`, level, ...content);
  match(context, NEWLINE);
  return heading;
}
function parseText(context: ParserContext): Text[] {
  const text: Text[] = [];
  const formatStack: TextFormat[] = [];
  let currentContent = "";
  
  while (nomatch(context, NEWLINE) && !isEnd(context)) {
    const node = previous(context) as VisibleToken;
    
    // Handle format start tokens
    if (node.type === BOLD_START) {
      if (currentContent) {
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
      }
      formatStack.push('bold');
    }
    else if (node.type === ITALIC_START) {
      if (currentContent) {
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
      }
      formatStack.push('italic');
    }
    else if (node.type === STRIKETHROUGH_START) {
      if (currentContent) {
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
      }
      formatStack.push('strikethrough');
    }
    else if (node.type === CODE_START) {
      if (currentContent) {
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
      }
      formatStack.push('code');
    }
    // Handle format end tokens (match closing with opening)
    else if (node.type === BOLD_END) {
      if (currentContent) {
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
      }
      const index = formatStack.lastIndexOf('bold');
      if (index !== -1) formatStack.splice(index, 1);
    }
    else if (node.type === ITALIC_END) {
      if (currentContent) {
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
      }
      const index = formatStack.lastIndexOf('italic');
      if (index !== -1) formatStack.splice(index, 1);
    }
    else if (node.type === STRIKETHROUGH_END) {
      if (currentContent) {
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
      }
      const index = formatStack.lastIndexOf('strikethrough');
      if (index !== -1) formatStack.splice(index, 1);
    }
    else if (node.type === CODE_END) {
      if (currentContent) {
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
      }
      const index = formatStack.lastIndexOf('code');
      if (index !== -1) formatStack.splice(index, 1);
    }
    // Handle text content
    else {
      currentContent += node.content;
    }
  }
  
  // Push any remaining content
  if (currentContent) {
    text.push({
      content: currentContent,
      formats: formatStack.length > 0 ? [...formatStack] : undefined,
    });
  }
  
  advance(context);
  return text;
}

function paresParagraph(context: ParserContext): Paragraph {
  const text = parseText(context);
  return {
    id: `block-${context.blockIdCounter++}`,
    type: "paragraph",
    content: text,
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
