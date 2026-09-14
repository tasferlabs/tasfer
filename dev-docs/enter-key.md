# Enter and Shift+Enter

What the two keys do in every block type. The code follows this table: each
row points at the handler that implements it. When the policy changes, change
this file first, then the handler and its test.

## The rule

**Enter continues what you are in. Enter on something empty takes you out.
Shift+Enter is the other one.**

- A block that holds several lines of its own (code, equation, table) keeps
  Enter for its own lines and uses Shift+Enter to leave.
- A one-line block (paragraph, heading, list item, quote) splits on Enter and
  leaves its type when it is empty. Shift+Enter does the same as Enter there,
  for now (a soft line break inside a paragraph is a later step).

## The keys and the actions

| Key         | Action        | Default when no block claims it |
| ----------- | ------------- | ------------------------------- |
| Enter       | `SPLIT_BLOCK` | split the block at the caret    |
| Shift+Enter | `EXIT_BLOCK`  | the same split as Enter         |
| Cmd/Ctrl+Enter | —          | opens the context menu          |

The key mapping lives in `packages/editor/src/events/keysEvents.ts` (the
`"Enter"` case). Both actions are declared in
`packages/editor/src/actions/edit-actions.ts`.

**Selected text first.** When a text range is selected, Enter and Shift+Enter
delete it before any block reacts, the same as typing over it
(`registerBreakReplacesSelection`, registered for every editor in
`createInitialState`). A whole block held as a node selection (an image, an
equation) is not a text range: Enter there starts a paragraph below.

## Per block

Caret positions: **empty** = the block has no content; **start**, **middle**,
**end** = where the caret sits in a non-empty block.

### Paragraph

| Empty               | Start                        | Middle        | End                   | Shift+Enter |
| ------------------- | ---------------------------- | ------------- | --------------------- | ----------- |
| new paragraph below | empty paragraph above        | split in two  | new paragraph below   | as Enter    |

Code: `splitBlock` in `packages/editor/src/actions/actions.ts`.

### Heading

| Empty                      | Start                                   | Middle        | End                 | Shift+Enter |
| -------------------------- | --------------------------------------- | ------------- | ------------------- | ----------- |
| becomes a paragraph        | empty paragraph above, heading moves down | two headings | paragraph below     | as Enter    |

Code: `splitBlock` (heading branch). If the schema refuses the conversion to a
paragraph, the empty heading stays and a paragraph is added below.

### List item (bullet, numbered, to-do)

| Empty                                        | Start            | Middle      | End                     | Shift+Enter |
| -------------------------------------------- | ---------------- | ----------- | ----------------------- | ----------- |
| moves out one level; at level 0 becomes a paragraph | empty item above | two items | new item (to-do unchecked) | as Enter |

Code: `splitBlock` (list branch).

### Quote

| Empty               | Start            | Middle     | End              | Shift+Enter |
| ------------------- | ---------------- | ---------- | ---------------- | ----------- |
| becomes a paragraph | empty quote above | two quotes | paragraph below | as Enter    |

Code: `QuoteNode.registerActions` in `packages/editor/src/nodes/QuoteNode.ts`
(empty and end); start and middle fall through to `splitBlock`.

### Code block

| Empty   | Start   | Middle  | End                                                              | Shift+Enter              |
| ------- | ------- | ------- | ---------------------------------------------------------------- | ------------------------ |
| newline | newline | newline | newline; the **third** Enter (text already ends in two blank lines) removes those two newlines and starts a paragraph below | paragraph below, from anywhere, text untouched |

Other ways out: Backspace in an empty code block turns it into a paragraph;
ArrowDown on the last line of the last block starts a paragraph below.

Code: `CodeNode.registerActions` in `packages/code/src/CodeNode.ts`.

### Display equation (math block)

| Empty               | Start                                          | Middle          | End             | Shift+Enter     |
| ------------------- | ---------------------------------------------- | --------------- | --------------- | --------------- |
| becomes a paragraph | paragraph above, caret stays in the equation   | paragraph below | paragraph below | paragraph below |

Enter never splits the LaTeX. "Start" means the nested caret is at the very
start of the equation's root row. The empty equation is tombstoned and a
paragraph takes its place (a structured equation cannot be retyped in place).

Not yet: Enter adding a row inside `aligned` / `cases` / a matrix. When that
lands, it belongs in the Middle/End columns for those environments only.

Code: `mathBlockEnter` in `packages/math/src/MathNode.ts`.

### Inline math (a formula inside prose)

| At a formula edge                           | Inside the formula                                        | Shift+Enter |
| ------------------------------------------- | --------------------------------------------------------- | ----------- |
| caret leaves the formula, then normal split | the formula is divided into two formulas, one per line | as Enter    |

Code: `prepareInlineMathTreeForBlockSplit` in
`packages/math/src/inline-tree-state.ts`, registered by `MathMark`.

### Table cell

| Any row but the last                  | Last row                                           | Shift+Enter                  |
| ------------------------------------- | -------------------------------------------------- | ---------------------------- |
| caret moves to the cell below, same column | a new row is added; caret lands in the same column | paragraph below the table |

A cell holds one line (GFM), so Enter never splits it.

Code: `registerTableInputActions` in `packages/table/src/input.ts`.

### Image, divider and other blocks without text

| Held as a node selection | Image in crop/reposition mode |
| ------------------------ | ----------------------------- |
| paragraph below          | Enter or Shift+Enter keeps the crop and leaves the mode |

Code: `splitBlock` (visual-block branch) and `ImageNode.registerActions`.

## Adding a new block type

A textual block gets the paragraph rules for free. A block that needs different
rules claims `SPLIT_BLOCK` and/or `EXIT_BLOCK` in its `registerActions`, and
uses `insertParagraphBeside` to start a paragraph above or below it. Add a row
to this file when you do.

## Tests

- `packages/math/src/enter-policy.test.ts` — selection, paragraph, heading,
  list, quote, equation, and the Shift key routing.
- `packages/code/src/CodeNode.test.ts` — code block rows.
- `packages/table/src/input.test.ts` — table rows.
