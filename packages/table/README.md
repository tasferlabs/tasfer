# @tasfer/table

The **opt-in table block** for
[`@tasfer/editor`](https://www.npmjs.com/package/@tasfer/editor) — a grid of
rich-text cells stored in a CRDT, with a GitHub-flavored Markdown round-trip.

## Install

```bash
npm install @tasfer/editor @tasfer/table
```

## Usage

```ts
import { baseSchema } from "@tasfer/editor/schema";
import { tableExtension } from "@tasfer/table";

const schema = baseSchema.use(tableExtension());
```

That is the full feature: the CRDT shape, the GFM round-trip, the on-canvas
grid, and editing inside a cell.

### Headless hosts

Workers, Markdown tooling and the CLI want the canvas-free half, which carries
no rendering code:

```ts
import { baseDataSchema } from "@tasfer/editor/baseDataSchema";
import { tableDataExtension } from "@tasfer/table/data";

const schema = baseDataSchema.extend(tableDataExtension());
```

A document containing tables parses, syncs and re-serializes losslessly with
it. A host that installs neither still loses nothing: the block round-trips and
renders through the engine's `UnknownNode` placeholder, the same "preserve and
degrade" contract every unregistered block type gets.

## On the canvas

The grid always fits the page width — the editor scrolls vertically only, so a
table that overflowed sideways would simply be unreachable. Columns split that
width evenly, and stay where they are: a width changes when someone drags an
edge, never because a cell's text grew. Cell text wraps inside whatever width
its column has, and no column goes under `blocks.table.minColumnWidth`.

The caret lives in a cell, addressed by that cell's identity rather than by a
position in the block, so a collaborator editing another cell never moves it.
Arrow keys step through a cell and cross into the next one at its edges; Tab
walks the cells in row-major order; Enter moves down a row (a GFM cell holds a
single line, so it cannot split). Vertical arrows also enter the table from the
block above or below and leave it at its top and bottom rows.

Appearance comes from the `blocks.table` theme leaf — hairlines, header wash,
cell padding and the rest — resolved from the host's own palette, so a table
follows dark mode like everything else.

### Editing the grid

Rows and columns are added and removed through the action bus, relative to the
cell the caret is in:

```ts
import {
  TABLE_INSERT_ROW,
  TABLE_DELETE_ROW,
  TABLE_INSERT_COLUMN,
  TABLE_DELETE_COLUMN,
  TABLE_SET_COLUMN_ALIGN,
} from "@tasfer/table";

editor.dispatch(TABLE_INSERT_ROW, { side: "after" });
editor.dispatch(TABLE_SET_COLUMN_ALIGN, { align: "right" });
```

Pass `rowIndex` / `columnIndex` to target a cell other than the caret's, and
`blockId` to target a table other than the caret's own. Every command emits
ordinary `content_edit` operations, so it merges, syncs and undoes like a typed
character.

Adding at the end of the grid also has a one-click route on the canvas. Rest the
mouse past the table's right edge, or just below its last row, and a band lights
up with a plus in it: clicking adds a column after the last one — or a row after
the last — and puts the caret in the cell it just made.

Only those two edges carry a strip. The left gutter belongs to the
block-reorder grip, which spans every block's full height, and there is nothing
to add above the grid (see the header rule below). The strips are mouse-only —
hover is what reveals them, and both sit where a thumb rests while scrolling
past a table. On a phone the same two commands live in the keyboard toolbar's
table panel.

Two guard rails are the grid's own: a table keeps at least one row and one
column, and nothing can be inserted above the header row — GFM writes the first
row as the column titles and has no syntax for anything before them. A refused
command returns nothing, which is a host's cue to disable the control.

To draw your own row/column panel, read the grid at the caret:

```ts
import { tableShapeAt } from "@tasfer/table";

const point = editor.state.contentSelection?.focus;
const document = point && editor.query.content(point.blockId, point.contentId);
const shape = document && point ? tableShapeAt(document, point) : undefined;
// → { rows, columns, rowIndex, columnIndex, align }
```

Converting a block to `table` — `setBlock({ type: "table" })`, or a slash menu —
creates a blank 3×3 grid with the caret in its first header cell.

### Column widths

Dragging an interior column edge trades width between the two columns it
separates; the outer edges are not draggable, because the grid is always exactly
as wide as the page. On touch the drag arms behind a short hold, so a scroll or
a long-press selection that starts near a column edge is never stolen. A dragged column stores its width as a **fraction** of the
grid, not a pixel count — the same document opens on a phone and on a desktop,
and a stored pixel width would be wrong on one of them. Untouched columns split
what is left evenly, and a stored width yields rather than squeeze another column
below `minColumnWidth` — as does the floor itself on a page too narrow to give
every column one.

Widths are presentation, not content: they live on the column node and never
appear in the Markdown.

## How a table is stored

Everything a table contains lives in **one structured CRDT attachment** on its
block. The block itself stores nothing.

```
root  (kind "table", authority "block")
  ├── slot "columns" → column nodes    { align? }
  └── slot "rows"    → row nodes
         └── slot "cells" → cell nodes { columnId }, textFields { text }
```

**Columns are nodes with identities, and every cell names its column.** This is
the decision the rest of the design rests on. If a row were just a list of cells
addressed by position, two people inserting a column at the same moment would
produce rows of different lengths with no way to say which cell belongs to
which column — a grid that can never be un-skewed. With column identities that
same edit is unambiguous, and the only visible consequence is a row that has no
cell for some column yet, which renders empty.

So a table is **not assumed to be rectangular**. `readTable` resolves cells by
column identity and reports the gaps, because a gap is a normal state a peer
sees, not a corruption.

Cell text is the engine's own character CRDT with inline marks, so bold, links
and the rest work inside a cell and merge per character.

## Markdown

Tables round-trip as GFM:

```markdown
| Fruit  | Price |
| ------ | ----: |
| Apples |  1.20 |
```

Cell content is inline Markdown, matching GFM: `**bold**` is bold, while `# not
a heading` stays literal text. Alignment (`:--`, `:-:`, `--:`) is preserved on
the column.

## License

MIT
