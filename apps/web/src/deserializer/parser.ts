import type { Block, Heading, Page, Paragraph, ImageCover, Text, TextFormat } from "./loadPage";
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
  LINK_END,
  LINK_START,
  LINK_TEXT_END,
  IMAGE_START,
  IMAGE_ALT_END,
  IMAGE_END,
  HTML_IMG,
  NEWLINE,
  STRIKETHROUGH_END,
  STRIKETHROUGH_START,
  TEXT,
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
  if (check(context, HTML_IMG)) return parseHTMLImageCover(context);
  if (check(context, IMAGE_START)) return parseImageCover(context);
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
  
  while (!isEnd(context) && nomatch(context, NEWLINE)) {
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
      formatStack.push({ type: 'bold' });
    }
    else if (node.type === ITALIC_START) {
      if (currentContent) {
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
      }
      formatStack.push({ type: 'italic' });
    }
    else if (node.type === STRIKETHROUGH_START) {
      if (currentContent) {
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
      }
      formatStack.push({ type: 'strikethrough' });
    }
    else if (node.type === CODE_START) {
      if (currentContent) {
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
      }
      formatStack.push({ type: 'code' });
    }
    else if (node.type === LINK_START) {
      if (currentContent) {
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
      }
      // Start collecting link text
    }
    else if (node.type === LINK_TEXT_END) {
      // Link text has ended, now URL starts
      // Push the link text content
      if (currentContent) {
        // Collect URL from next TEXT token
        let linkUrl = "";
        
        // Peek ahead to get URL
        if (!isEnd(context)) {
          const nextToken = peek(context);
          if (nextToken.type === 'text') {
            advance(context);
            linkUrl = (previous(context) as VisibleToken).content;
          }
        }
        
        // Now add the link format with URL
        formatStack.push({ type: 'link', url: linkUrl });
        
        text.push({
          content: currentContent,
          formats: formatStack.length > 0 ? [...formatStack] : undefined,
        });
        currentContent = "";
        
        // Remove link from stack
        const index = formatStack.findIndex(f => f.type === 'link');
        if (index !== -1) formatStack.splice(index, 1);
      }
    }
    else if (node.type === LINK_END) {
      // Link has ended, already handled in LINK_TEXT_END
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
      const index = formatStack.findIndex(f => f.type === 'bold');
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
      const index = formatStack.findIndex(f => f.type === 'italic');
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
      const index = formatStack.findIndex(f => f.type === 'strikethrough');
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
      const index = formatStack.findIndex(f => f.type === 'code');
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

function parseImageCover(context: ParserContext): ImageCover {
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
    type: "imageCover",
    url: imageUrl,
    alt: altText,
    // Default properties - not specified in markdown
  };
}

function parseHTMLImageCover(context: ParserContext): ImageCover {
  // <img src="url" alt="alt" width="..." height="..." data-object-fit="..." />
  match(context, HTML_IMG);
  const htmlTag = (previous(context) as VisibleToken).content;
  
  // Parse attributes from HTML tag
  const srcMatch = /src="([^"]+)"/.exec(htmlTag);
  const altMatch = /alt="([^"]*)"/.exec(htmlTag);
  const widthMatch = /(?:width|data-width)="([^"]+)"/.exec(htmlTag);
  const heightMatch = /height="([^"]+)"/.exec(htmlTag);
  const objectFitMatch = /data-object-fit="([^"]+)"/.exec(htmlTag);
  
  const imageUrl = srcMatch ? srcMatch[1] : '';
  const altText = altMatch ? altMatch[1] : '';
  const width = widthMatch ? (widthMatch[1] === 'full' ? 'full' : parseInt(widthMatch[1], 10)) : undefined;
  const height = heightMatch ? parseInt(heightMatch[1], 10) : undefined;
  const objectFit = objectFitMatch ? objectFitMatch[1] as ('cover' | 'contain') : undefined;
  
  // Consume optional newline
  match(context, NEWLINE);
  
  return {
    id: `block-${context.blockIdCounter++}`,
    type: "imageCover",
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
