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
export const NEWLINE = "newline";

type FormatTokenType = "bold_start" | "bold_end" | "italic_start" | "italic_end" | "strikethrough_start" | "strikethrough_end" | "code_start" | "code_end";
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
    
    // Check for code (backticks) - code doesn't nest
    if (char === "`") {
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
        state.index = start;
        tokenizeRegularText(state, tokens);
      }
    }
    // Check for strikethrough (~~)
    else if (char === "~" && peek(state) === "~") {
      const existingIndex = formatStack.findIndex(f => f.type === 'strikethrough');
      if (existingIndex !== -1) {
        tokens.push({ type: STRIKETHROUGH_END, content: "~~" });
        formatStack.splice(existingIndex, 1);
      } else {
        tokens.push({ type: STRIKETHROUGH_START, content: "~~" });
        formatStack.push({ type: 'strikethrough', marker: '~~' });
      }
      next(state, 2);
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
    if (char === "*" || char === "`" || char === "~") {
      break;
    }
    next(state);
  }
  
  const text = state.content.slice(start, state.index);
  if (text.length > 0) {
    tokens.push({ type: TEXT, content: text });
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
