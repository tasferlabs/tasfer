import type { Block, Heading, Page, Paragraph, Text } from "./loadPage";
import {
  HEADING_1,
  HEADING_2,
  HEADING_3,
  NEWLINE,
  type Token,
  type TokenType,
  type VisibleToken,
} from "./tokenizer";

interface ParserContext {
  tokens: Token[];
  current: number;
}

function generateEmptyTree(): Page {
  return {
    title: "",
    blocks: [],
  };
}
function generateHeading(level: number, ...content: Text[]): Heading {
  return {
    type: "heading" + level as "heading1" | "heading2" | "heading3",
    content: content || [],
  };
}

export default function parsePage(tokens: Token[]): Page {
  const tree = generateEmptyTree();

  const context: ParserContext = {
    tokens,
    current: 0,
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
  if (match(context, HEADING_1)) return parseHeading(context, 1);
  if (match(context, HEADING_2)) return parseHeading(context, 2);
  if (match(context, HEADING_3)) return parseHeading(context, 3);

  return paresParagraph(context);
}

function parseHeading(context: ParserContext, level: number) {
  const content = parseText(context);
  const heading = generateHeading(level, ...content);
  match(context, NEWLINE);
  return heading;
}
function parseText(context: ParserContext): Text[] {
  const text: Text[] = [];
  while (nomatch(context, NEWLINE) && !isEnd(context)) {
    const node = previous(context) as VisibleToken;
    text.push({
      content: node.content,
    });
  }
  advance(context);

  return text;
}

function paresParagraph(context: ParserContext): Paragraph {
  const text = parseText(context);
  match(context, NEWLINE);
  return {
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
