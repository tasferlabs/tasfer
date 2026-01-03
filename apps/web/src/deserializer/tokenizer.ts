interface TokenizerState {
  content: string;
  index: number;
  startOfLine: boolean;
}
export const HEADING_1 = "heading1";
export const HEADING_2 = "heading2";
export const HEADING_3 = "heading3";
export const TEXT = "text";
export const BOLD_START = "bold_start";
export const BOLD_END = "bold_end";
export const ITALIC_START = "italic_start";
export const ITALIC_END = "italic_end";
export const STRIKETHROUGH_START = "strikethrough_start";
export const STRIKETHROUGH_END = "strikethrough_end";
export const CODE_START = "code_start";
export const CODE_END = "code_end";
export const LINK_START = "link_start";
export const LINK_TEXT_END = "link_text_end";
export const LINK_END = "link_end";
export const IMAGE_START = "image_start";
export const IMAGE_ALT_END = "image_alt_end";
export const IMAGE_END = "image_end";
export const NEWLINE = "newline";

type FormatTokenType = "bold_start" | "bold_end" | "italic_start" | "italic_end" | "strikethrough_start" | "strikethrough_end" | "code_start" | "code_end" | "link_start" | "link_text_end" | "link_end" | "image_start" | "image_alt_end" | "image_end";
type VisibleTokenType = "heading1" | "heading2" | "heading3" | "text" | FormatTokenType;
export type TokenType = VisibleTokenType | "newline";

export type VisibleToken = {
  type: VisibleTokenType;
  content: string;
};

type NewLineToken = {
  type: "newline";
};

export type Token = NewLineToken | VisibleToken;

export default function tokenizePage(content: string) {
  const state = {
    index: 0,
    startOfLine: true,
    content,
  };
  const tokens: Token[] = [];
  while (!isEnd(state)) {
    const char = current(state);
    if (char === " " && state.startOfLine) {
      next(state);
    } else if (char === "\r") {
      next(state);
      if (peek(state) === "\n") {
        state.startOfLine = true;
        tokens.push({
          type: "newline",
        });
        next(state);
      }
    } else if (char === "\n") {
      state.startOfLine = true;
      tokens.push({
        type: "newline",
      });
      next(state);
    } else if (char === "#" && state.startOfLine) {
      tokenizeHeading(state, tokens);
    } else {
      tokenizeLine(state, tokens);
    }
  }
  return tokens;
}
function tokenizeHeading(state: TokenizerState, tokens: Token[]) {
  if (!state.startOfLine) {
    tokenizeLine(state, tokens);
    return;
  }
  if (peek(state, -1) === "/") {
    tokenizeLine(state, tokens);
    return;
  }

  let steps = 1;
  while (peek(state, steps) == "#" && steps < 6 && !isEnd(state)) {
    steps++;
  }
  if (peek(state, steps) == " ") {
    tokens.push({
      type: `heading${steps}` as TokenType,
      content: "#".repeat(steps),
    });
    next(state, steps + 1);
    state.startOfLine = false;
  } else {
    tokenizeLine(state, tokens);
  }
}
function tokenizeLine(state: TokenizerState, tokens: Token[]) {
  state.startOfLine = false;
  const formatStack: Array<{ type: 'bold' | 'italic' | 'strikethrough'; marker: string }> = [];
  
  while (!isEnd(state) && current(state) !== "\n" && current(state) !== "\r") {
    const char = current(state);
    
    // Check for images ![alt](url)
    if (char === "!" && peek(state) === "[") {
      const start = state.index;
      next(state, 2); // Skip ![ 
      
      // Find closing ]
      let foundAltEnd = false;
      let altEndIndex = state.index;
      while (!isEnd(state) && current(state) !== "\n" && current(state) !== "\r") {
        if (current(state) === "]") {
          altEndIndex = state.index;
          foundAltEnd = true;
          break;
        }
        next(state);
      }
      
      // Check if followed by (url)
      if (foundAltEnd && peek(state) === "(") {
        next(state, 2); // Skip ] and (
        let urlStart = state.index;
        let foundUrlEnd = false;
        
        while (!isEnd(state) && current(state) !== "\n" && current(state) !== "\r") {
          if (current(state) === ")") {
            foundUrlEnd = true;
            break;
          }
          next(state);
        }
        
        if (foundUrlEnd) {
          // Valid image found
          tokens.push({ type: IMAGE_START, content: "![" });
          const altText = state.content.slice(start + 2, altEndIndex);
          if (altText.length > 0) {
            tokens.push({ type: TEXT, content: altText });
          }
          tokens.push({ type: IMAGE_ALT_END, content: "](" });
          const imageUrl = state.content.slice(urlStart, state.index);
          if (imageUrl.length > 0) {
            tokens.push({ type: TEXT, content: imageUrl });
          }
          tokens.push({ type: IMAGE_END, content: ")" });
          next(state);
          continue;
        }
      }
      
      // Not a valid image, treat as regular text
      state.index = start;
      // Consume the ! character and continue
      const text = current(state);
      tokens.push({ type: TEXT, content: text });
      next(state);
    }
    // Check for links [text](url)
    else if (char === "[") {
      const start = state.index;
      next(state);
      
      // Find closing ]
      let foundTextEnd = false;
      let textEndIndex = state.index;
      while (!isEnd(state) && current(state) !== "\n" && current(state) !== "\r") {
        if (current(state) === "]") {
          textEndIndex = state.index;
          foundTextEnd = true;
          break;
        }
        next(state);
      }
      
      // Check if followed by (url)
      if (foundTextEnd && peek(state) === "(") {
        next(state, 2); // Skip ] and (
        let urlStart = state.index;
        let foundUrlEnd = false;
        
        while (!isEnd(state) && current(state) !== "\n" && current(state) !== "\r") {
          if (current(state) === ")") {
            foundUrlEnd = true;
            break;
          }
          next(state);
        }
        
        if (foundUrlEnd) {
          // Valid link found
          tokens.push({ type: LINK_START, content: "[" });
          const linkText = state.content.slice(start + 1, textEndIndex);
          if (linkText.length > 0) {
            tokens.push({ type: TEXT, content: linkText });
          }
          tokens.push({ type: LINK_TEXT_END, content: "](" });
          const linkUrl = state.content.slice(urlStart, state.index);
          if (linkUrl.length > 0) {
            tokens.push({ type: TEXT, content: linkUrl });
          }
          tokens.push({ type: LINK_END, content: ")" });
          next(state);
          continue;
        }
      }
      
      // Not a valid link, treat as regular text
      state.index = start;
      // Consume the [ character and continue
      const text = current(state);
      tokens.push({ type: TEXT, content: text });
      next(state);
    }
    // Check for code (backticks) - code doesn't nest
    else if (char === "`") {
      const start = state.index;
      next(state);
      
      // Find closing backtick
      let foundEnd = false;
      while (!isEnd(state) && current(state) !== "\n" && current(state) !== "\r") {
        if (current(state) === "`") {
          foundEnd = true;
          break;
        }
        next(state);
      }
      
      if (foundEnd) {
        tokens.push({ type: CODE_START, content: "`" });
        const codeContent = state.content.slice(start + 1, state.index);
        if (codeContent.length > 0) {
          tokens.push({ type: TEXT, content: codeContent });
        }
        tokens.push({ type: CODE_END, content: "`" });
        next(state);
      } else {
        // No closing backtick found, treat as regular text
        state.index = start;
        const text = current(state);
        tokens.push({ type: TEXT, content: text });
        next(state);
      }
    }
    // Check for strikethrough (~~)
    else if (char === "~") {
      if (peek(state) === "~") {
        const existingIndex = formatStack.findIndex(f => f.type === 'strikethrough');
        if (existingIndex !== -1) {
          tokens.push({ type: STRIKETHROUGH_END, content: "~~" });
          formatStack.splice(existingIndex, 1);
        } else {
          tokens.push({ type: STRIKETHROUGH_START, content: "~~" });
          formatStack.push({ type: 'strikethrough', marker: '~~' });
        }
        next(state, 2);
      } else {
        // Single ~ is just regular text
        tokens.push({ type: TEXT, content: "~" });
        next(state);
      }
    }
    // Check for bold (**) or italic (*)
    else if (char === "*") {
      if (peek(state) === "*") {
        const existingIndex = formatStack.findIndex(f => f.type === 'bold');
        if (existingIndex !== -1) {
          tokens.push({ type: BOLD_END, content: "**" });
          formatStack.splice(existingIndex, 1);
        } else {
          tokens.push({ type: BOLD_START, content: "**" });
          formatStack.push({ type: 'bold', marker: '**' });
        }
        next(state, 2);
      } else {
        const existingIndex = formatStack.findIndex(f => f.type === 'italic');
        if (existingIndex !== -1) {
          tokens.push({ type: ITALIC_END, content: "*" });
          formatStack.splice(existingIndex, 1);
        } else {
          tokens.push({ type: ITALIC_START, content: "*" });
          formatStack.push({ type: 'italic', marker: '*' });
        }
        next(state);
      }
    }
    // Plain text
    else {
      tokenizeRegularText(state, tokens);
    }
  }
}

function tokenizeRegularText(state: TokenizerState, tokens: Token[]) {
  const start = state.index;
  
  // Consume characters until we hit a formatting marker or line end
  while (!isEnd(state) && current(state) !== "\n" && current(state) !== "\r") {
    const char = current(state);
    if (char === "*" || char === "`" || char === "~" || char === "[" || char === "!") {
      break;
    }
    next(state);
  }
  
  const text = state.content.slice(start, state.index);
  if (text.length > 0) {
    tokens.push({ type: TEXT, content: text });
  } else if (!isEnd(state) && current(state) !== "\n" && current(state) !== "\r") {
    // If we didn't consume anything and we're at a special character that wasn't
    // handled by the caller, consume it as regular text to avoid infinite loop
    tokens.push({ type: TEXT, content: current(state) });
    next(state);
  }
}
function isEnd(state: TokenizerState) {
  return state.content.length <= state.index;
}

function current(state: TokenizerState) {
  return state.content[state.index];
}

function next(state: TokenizerState, increment = 1) {
  return state.content[(state.index += increment)];
}
function peek(state: TokenizerState, index = 1) {
  if (index < 0) return null;
  if (state.content.length < index) return null;
  return state.content[state.index + index];
}

export function stringifyToken(token: Token): string {
  if (token.type === NEWLINE) return "lb";
  if (token.type === TEXT) return `"${token.content}"`;

  return token.type;
}
