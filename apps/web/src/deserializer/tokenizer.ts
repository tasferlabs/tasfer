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
export const HTML_IMG = "html_img";
export const BULLET_LIST = "bullet_list";
export const NUMBERED_LIST = "numbered_list";
export const TODO_LIST_UNCHECKED = "todo_unchecked";
export const TODO_LIST_CHECKED = "todo_checked";
export const INDENT = "indent";
export const HORIZONTAL_RULE = "horizontal_rule";
export const MATH_BLOCK = "math_block";
export const INLINE_MATH_START = "inline_math_start";
export const INLINE_MATH_END = "inline_math_end";
export const NEWLINE = "newline";

type FormatTokenType =
  | "bold_start"
  | "bold_end"
  | "italic_start"
  | "italic_end"
  | "strikethrough_start"
  | "strikethrough_end"
  | "code_start"
  | "code_end"
  | "link_start"
  | "link_text_end"
  | "link_end"
  | "image_start"
  | "image_alt_end"
  | "image_end"
  | "html_img"
  | "inline_math_start"
  | "inline_math_end";
type ListTokenType =
  | "bullet_list"
  | "numbered_list"
  | "todo_unchecked"
  | "todo_checked"
  | "indent";
type HeadingTokenTypes = "heading1" | "heading2" | "heading3";
type VisibleTokenType =
  | HeadingTokenTypes
  | "text"
  | "horizontal_rule"
  | "math_block"
  | FormatTokenType
  | ListTokenType;
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
    // Handle leading spaces for indentation at start of line
    if (char === " " && state.startOfLine) {
      const indentLevel = countLeadingSpaces(state);
      if (indentLevel > 0) {
        tokens.push({
          type: INDENT,
          content: " ".repeat(indentLevel * 2),
        });
        next(state, indentLevel * 2);
      } else {
        next(state);
      }
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
    } else if (state.startOfLine && tryTokenizeHorizontalRule(state, tokens)) {
      // Horizontal rule was tokenized, continue
    } else if (state.startOfLine && tryTokenizeList(state, tokens)) {
      // List was tokenized, continue
      state.startOfLine = false;
    } else if (state.startOfLine && tryTokenizeMathBlock(state, tokens)) {
      // Math block was tokenized, continue
    } else {
      tokenizeLine(state, tokens);
    }
  }
  return tokens;
}
// Try to tokenize horizontal rule (--- or more dashes at start of line)
// Returns true if horizontal rule was found and tokenized
function tryTokenizeHorizontalRule(
  state: TokenizerState,
  tokens: Token[]
): boolean {
  const char = current(state);

  // Check for horizontal rule: --- or more dashes
  if (char === "-") {
    let dashCount = 0;
    let i = 0;

    // Count consecutive dashes
    while (peek(state, i) === "-") {
      dashCount++;
      i++;
    }

    // Must have at least 3 dashes
    if (dashCount >= 3) {
      // Check that rest of line is empty (newline or end of file)
      const nextChar = peek(state, i);
      if (
        nextChar === null ||
        nextChar === "\n" ||
        nextChar === "\r" ||
        isEnd(state)
      ) {
        tokens.push({
          type: HORIZONTAL_RULE,
          content: "-".repeat(dashCount),
        });
        next(state, dashCount);
        return true;
      }
    }
  }

  return false;
}

// Try to tokenize display math block ($$...$$) at start of line
function tryTokenizeMathBlock(
  state: TokenizerState,
  tokens: Token[]
): boolean {
  const char = current(state);
  if (char !== "$" || peek(state) !== "$") return false;

  // Find closing $$
  let i = 2; // Skip opening $$
  // Skip optional newline after opening $$
  if (peek(state, i) === "\n") i++;
  else if (peek(state, i) === "\r" && peek(state, i + 1) === "\n") i += 2;

  const contentStart = i;
  let found = false;

  while (state.index + i < state.content.length) {
    if (
      state.content[state.index + i] === "$" &&
      state.index + i + 1 < state.content.length &&
      state.content[state.index + i + 1] === "$"
    ) {
      found = true;
      break;
    }
    i++;
  }

  if (!found) return false;

  let latex = state.content.slice(state.index + contentStart, state.index + i);
  // Trim trailing newline before closing $$
  if (latex.endsWith("\n")) latex = latex.slice(0, -1);
  if (latex.endsWith("\r")) latex = latex.slice(0, -1);

  tokens.push({
    type: MATH_BLOCK,
    content: latex,
  });

  next(state, i + 2); // Skip content + closing $$

  // Skip optional trailing newline
  if (!isEnd(state) && current(state) === "\n") {
    tokens.push({ type: "newline" });
    next(state);
  } else if (
    !isEnd(state) &&
    current(state) === "\r" &&
    peek(state) === "\n"
  ) {
    tokens.push({ type: "newline" });
    next(state, 2);
  }

  return true;
}

// Count leading spaces for indent detection (2 spaces = 1 indent level)
function countLeadingSpaces(state: TokenizerState): number {
  let count = 0;
  let i = 0;
  while (peek(state, i) === " " && !isEnd(state)) {
    count++;
    i++;
  }
  // Return number of indent levels (2 spaces = 1 level)
  return Math.floor(count / 2);
}

// Try to tokenize list markers at start of line
// Returns true if list marker was found and tokenized
function tryTokenizeList(state: TokenizerState, tokens: Token[]): boolean {
  const char = current(state);

  // Check for bullet list: "- ", "* ", "+ "
  if ((char === "-" || char === "*" || char === "+") && peek(state) === " ") {
    // Check if it's a todo list: "- [ ]" or "- [x]"
    if (char === "-" && peek(state, 2) === "[") {
      const checkChar = peek(state, 3);
      if (
        (checkChar === " " || checkChar === "x" || checkChar === "X") &&
        peek(state, 4) === "]" &&
        peek(state, 5) === " "
      ) {
        // Todo list item
        const isChecked = checkChar === "x" || checkChar === "X";
        tokens.push({
          type: isChecked ? TODO_LIST_CHECKED : TODO_LIST_UNCHECKED,
          content: isChecked ? "- [x] " : "- [ ] ",
        });
        next(state, 6); // Skip "- [x] " or "- [ ] "
        return true;
      }
    }

    // Regular bullet list
    tokens.push({
      type: BULLET_LIST,
      content: char + " ",
    });
    next(state, 2); // Skip marker and space
    return true;
  }

  // Check for numbered list: "1. ", "2. ", etc.
  if (char >= "0" && char <= "9") {
    let numEnd = 0;
    let nextChar = peek(state, numEnd);
    while (
      nextChar !== null &&
      nextChar >= "0" &&
      nextChar <= "9" &&
      !isEnd(state)
    ) {
      numEnd++;
      nextChar = peek(state, numEnd);
    }
    const dotChar = peek(state, numEnd);
    const spaceChar = peek(state, numEnd + 1);
    if (dotChar === "." && spaceChar === " ") {
      const number = state.content.slice(state.index, state.index + numEnd);
      tokens.push({
        type: NUMBERED_LIST,
        content: number + ". ",
      });
      next(state, numEnd + 2); // Skip number, ".", and space
      return true;
    }
  }

  return false;
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
      type: `heading${steps}` as HeadingTokenTypes,
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
  const formatStack: Array<{
    type: "bold" | "italic" | "strikethrough";
    marker: string;
  }> = [];

  while (!isEnd(state) && current(state) !== "\n" && current(state) !== "\r") {
    const char = current(state);

    // Check for HTML img tags <img ... />
    if (
      char === "<" &&
      peek(state) === "i" &&
      peek(state, 2) === "m" &&
      peek(state, 3) === "g" &&
      (peek(state, 4) === " " || peek(state, 4) === ">")
    ) {
      const start = state.index;

      // Find the end of the tag (either /> or >)
      let foundEnd = false;
      while (
        !isEnd(state) &&
        current(state) !== "\n" &&
        current(state) !== "\r"
      ) {
        if (current(state) === ">") {
          foundEnd = true;
          next(state); // Include the >
          break;
        }
        next(state);
      }

      if (foundEnd) {
        // Extract the full HTML tag
        const htmlTag = state.content.slice(start, state.index);
        tokens.push({ type: HTML_IMG, content: htmlTag });
        continue;
      } else {
        // Not a valid HTML tag, treat as regular text
        state.index = start;
        const text = current(state);
        tokens.push({ type: TEXT, content: text });
        next(state);
      }
    }
    // Check for images ![alt](url)
    else if (char === "!" && peek(state) === "[") {
      const start = state.index;
      next(state, 2); // Skip ![

      // Find closing ]
      let foundAltEnd = false;
      let altEndIndex = state.index;
      while (
        !isEnd(state) &&
        current(state) !== "\n" &&
        current(state) !== "\r"
      ) {
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

        while (
          !isEnd(state) &&
          current(state) !== "\n" &&
          current(state) !== "\r"
        ) {
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
      while (
        !isEnd(state) &&
        current(state) !== "\n" &&
        current(state) !== "\r"
      ) {
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

        while (
          !isEnd(state) &&
          current(state) !== "\n" &&
          current(state) !== "\r"
        ) {
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
    // Check for inline math ($...$) - does not nest, content is verbatim LaTeX.
    // Single $ only; $$ at start of line is the display math block (handled elsewhere).
    else if (char === "$") {
      const start = state.index;
      next(state); // consume opening $

      // Find closing $ on the same line. Reject empty content.
      let foundEnd = false;
      const contentStart = state.index;
      while (
        !isEnd(state) &&
        current(state) !== "\n" &&
        current(state) !== "\r"
      ) {
        if (current(state) === "$") {
          foundEnd = true;
          break;
        }
        next(state);
      }

      if (foundEnd && state.index > contentStart) {
        const latex = state.content.slice(contentStart, state.index);
        tokens.push({ type: INLINE_MATH_START, content: "$" });
        tokens.push({ type: TEXT, content: latex });
        tokens.push({ type: INLINE_MATH_END, content: "$" });
        next(state); // consume closing $
      } else {
        // Not a valid inline math, treat the $ as literal text
        state.index = start;
        tokens.push({ type: TEXT, content: "$" });
        next(state);
      }
    }
    // Check for code (backticks) - code doesn't nest
    else if (char === "`") {
      const start = state.index;
      next(state);

      // Find closing backtick
      let foundEnd = false;
      while (
        !isEnd(state) &&
        current(state) !== "\n" &&
        current(state) !== "\r"
      ) {
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
        const existingIndex = formatStack.findIndex(
          (f) => f.type === "strikethrough"
        );
        if (existingIndex !== -1) {
          tokens.push({ type: STRIKETHROUGH_END, content: "~~" });
          formatStack.splice(existingIndex, 1);
        } else {
          tokens.push({ type: STRIKETHROUGH_START, content: "~~" });
          formatStack.push({ type: "strikethrough", marker: "~~" });
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
        const existingIndex = formatStack.findIndex((f) => f.type === "bold");
        if (existingIndex !== -1) {
          tokens.push({ type: BOLD_END, content: "**" });
          formatStack.splice(existingIndex, 1);
        } else {
          tokens.push({ type: BOLD_START, content: "**" });
          formatStack.push({ type: "bold", marker: "**" });
        }
        next(state, 2);
      } else {
        const existingIndex = formatStack.findIndex((f) => f.type === "italic");
        if (existingIndex !== -1) {
          tokens.push({ type: ITALIC_END, content: "*" });
          formatStack.splice(existingIndex, 1);
        } else {
          tokens.push({ type: ITALIC_START, content: "*" });
          formatStack.push({ type: "italic", marker: "*" });
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
    if (
      char === "*" ||
      char === "`" ||
      char === "~" ||
      char === "[" ||
      char === "!" ||
      char === "<" ||
      char === "$"
    ) {
      break;
    }
    next(state);
  }

  const text = state.content.slice(start, state.index);
  if (text.length > 0) {
    tokens.push({ type: TEXT, content: text });
  } else if (
    !isEnd(state) &&
    current(state) !== "\n" &&
    current(state) !== "\r"
  ) {
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
