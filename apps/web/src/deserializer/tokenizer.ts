interface TokenizerState {
  content: string;
  index: number;
  startOfLine: boolean;
}
export const HEADING_1 = "heading1";
export const HEADING_2 = "heading2";
export const HEADING_3 = "heading3";
export const TEXT = "text";
export const NEWLINE = "newline";
type VisibleTokenType = "heading1" | "heading2" | "heading3" | "text";
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
    if (char === " ") {
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
    } else if (char === "#") {
      tokenizeHeading(state, tokens);
    } else {
      tokenizeText(state, tokens);
    }
  }
  return tokens;
}
function tokenizeHeading(state: TokenizerState, tokens: Token[]) {
  if (!state.startOfLine) {
    tokenizeText(state, tokens);
    return;
  }
  if (peek(state, -1) === "/") {
    tokenizeText(state, tokens);
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
  } else {
    tokenizeText(state, tokens);
  }
}
function tokenizeText(state: TokenizerState, tokens: Token[]) {
  let start = state.index;
  while (next(state) !== "\n" && !isEnd(state)) {}

  tokens.push({
    type: TEXT,
    content: state.content.slice(start, state.index),
  });
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
