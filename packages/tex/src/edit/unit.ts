/**
 * Structural, level-aware *editing units* for live math editing.
 *
 * The editor edits math through one primitive: a selection. {@link unitBefore} /
 * {@link unitAfter} answer the question the caret-side actions ask — "what is the
 * one unit adjacent to the caret?" — as a source `[start, end)` range. The editor
 * then acts on it through its normal selection machinery: a multi-part construct
 * (`\frac{a}{b}`, `x^{2}`, a brace group) is *selected* so you can see it before
 * the next press deletes it, while a plain leaf (a character, a command name like
 * `\sin`, a space) is deleted outright. `isConstruct` carries that distinction;
 * the select-vs-delete policy itself lives in the editor, not here.
 *
 * Deleting a single source character inside a construct would leave broken LaTeX
 * (`\frac{a}{b}` → `\frac{a{b}`), so the unit is always a whole, well-formed
 * piece. The level-awareness falls out of the AST descent: a unit ending exactly
 * at the caret in the innermost group is the unit at the current level; a caret
 * sitting at a group's start has nothing there, so we escalate to the enclosing
 * construct. Command names (`\sin`, `\pm`) are single AST nodes, so a unit never
 * chips a command into a broken `\si`/`\s` — the token-granularity the inline
 * chips need falls out of the same descent, no separate lexer pass required.
 */
import type { Node } from "../parse/ast";
import { parse } from "../parse/parser";

/** The resolved editing unit adjacent to a caret. */
export interface MathUnit {
  /** Source range of the unit (half-open `[start, end)`). */
  readonly start: number;
  readonly end: number;
  /**
   * `true` when the unit is a multi-part construct (fraction, root, script,
   * group, …) — the editor selects it first and deletes on the next press.
   * `false` for a plain leaf (single character, `\sin`, a space) — delete now.
   */
  readonly isConstruct: boolean;
}

/** Which side of the caret the unit sits on. */
type Direction = "backward" | "forward";

/** Leaf node types — taking one whole never yields partial LaTeX, so no select-first. */
function isLeaf(node: Node): boolean {
  switch (node.type) {
    case "atom":
    case "space":
    case "opname":
    case "sizeddelim":
    case "unknown":
      return true;
    default:
      return false;
  }
}

/**
 * The sibling lists that form a node's editable slots, with each slot's
 * argument-`{}` wrapper unwrapped to its body. Unwrapping matters for
 * escalation: the parent of the caret's group must be the CONSTRUCT (so a caret
 * at a fraction's numerator start escalates to the whole `\frac`), not the
 * invisible `ord` that wraps the argument.
 */
function slotBody(node: Node): Node[] {
  return node.type === "ord" ? node.body : [node];
}

function childGroups(node: Node): Node[][] {
  switch (node.type) {
    case "ord":
    case "style":
    case "leftright":
      return [node.body];
    case "frac":
      return [slotBody(node.num), slotBody(node.den)];
    case "sqrt":
      return node.index
        ? [slotBody(node.index), slotBody(node.body)]
        : [slotBody(node.body)];
    case "supsub":
      return [
        node.base ? slotBody(node.base) : [],
        node.sup ? slotBody(node.sup) : [],
        node.sub ? slotBody(node.sub) : [],
      ].filter((g) => g.length > 0);
    case "accent":
    case "not":
      return [slotBody(node.base)];
    case "overunder":
    case "mathfont":
    case "mclass":
    case "boxed":
    case "phantom":
      return [slotBody(node.body)];
    case "stack":
      return [slotBody(node.script), slotBody(node.base)];
    case "array":
      return node.rows.flatMap((row) => row.map((cell) => slotBody(cell)));
    default:
      return [];
  }
}

/**
 * Whether source position `pos` falls inside some `unknown` command's span —
 * i.e. the character there is part of a command the user is still typing. Walks
 * the whole tree (an unknown can be nested in a fraction numerator, a script,
 * …) via the same {@link childGroups} descent the unit resolver uses.
 */
function inUnknown(node: Node, pos: number): boolean {
  if (node.type === "unknown") {
    return pos >= node.span.start && pos < node.span.end;
  }
  for (const group of childGroups(node)) {
    for (const child of group) {
      if (inUnknown(child, pos)) return true;
    }
  }
  return false;
}

/**
 * Descend to the innermost sibling list the caret sits within, tracking the
 * enclosing construct so a caret at a group's start can escalate to it. Returns
 * the sibling list and that construct (`null` at the top level).
 */
function locate(
  siblings: Node[],
  offset: number,
  parent: Node | null,
): { siblings: Node[]; parent: Node | null } {
  for (const child of siblings) {
    if (offset > child.span.start && offset < child.span.end) {
      for (const group of childGroups(child)) {
        // An empty slot (e.g. the numerator of `\frac{}{b}`) has no nodes and so
        // no span to test — skip it; the caret falling there is handled by the
        // escalation below.
        if (group.length === 0) continue;
        const gStart = group[0].span.start;
        const gEnd = group[group.length - 1].span.end;
        if (offset >= gStart && offset <= gEnd) {
          return locate(group, offset, child);
        }
      }
      // Inside `child` but not within any populated content slot — either between
      // its delimiters or inside an EMPTY slot. Escalate to `child` so the whole
      // construct is the unit, rather than chipping a brace into partial LaTeX.
      return { siblings: [], parent: child };
    }
  }
  return { siblings, parent };
}

/**
 * When the caret sits inside an EMPTY script slot (`\int_{}`, `x^{}`), the unit
 * is that whole script token (`_{}` / `^{}`) — a delete peels the empty script
 * off and keeps the base, rather than escalating to the whole scripted construct
 * (which would take the operator and any other script with it). This is what
 * makes a limit "optional": type `_`, change your mind, backspace back to a bare
 * `\int`. The `_`/`^` operator sits one char before the slot's `{`, so the token
 * starts at `slot.span.start - 1`. Deleting immediately (`isConstruct: false`) —
 * an empty slot has nothing to preview losing.
 */
function emptyScriptUnit(parent: Node, offset: number): MathUnit | null {
  if (parent.type !== "supsub") return null;
  for (const slot of [parent.sub, parent.sup]) {
    if (
      slot &&
      slot.type === "ord" &&
      slot.body.length === 0 &&
      offset > slot.span.start &&
      offset < slot.span.end
    ) {
      return {
        start: slot.span.start - 1,
        end: slot.span.end,
        isConstruct: false,
      };
    }
  }
  return null;
}

/**
 * Resolve the editing unit for a caret at `offset` on the given side. Returns
 * `null` when there is nothing on that side (caret at the very start for
 * backward / end for forward) — the caller falls back to its normal block-level
 * behavior (e.g. merging blocks).
 */
function resolve(
  latex: string,
  offset: number,
  direction: Direction,
): MathUnit | null {
  if (direction === "backward" ? offset <= 0 : offset >= latex.length) {
    return null;
  }

  const root = parse(latex);
  if (root.type !== "ord") return null;

  // An unrecognized command (`\al`) is still being typed — not a construct yet.
  // Treat it as the plain characters it visually is: the unit is the single
  // source char adjacent to the caret, so a delete removes one character at a
  // time and the caret steps through it, rather than the whole `\al` deleting
  // (or, if it parsed as something bigger, selecting) at once.
  const adjacent = direction === "backward" ? offset - 1 : offset;
  if (inUnknown(root, adjacent)) {
    return direction === "backward"
      ? { start: offset - 1, end: offset, isConstruct: false }
      : { start: offset, end: offset + 1, isConstruct: false };
  }

  const { siblings, parent } = locate(root.body, offset, null);

  // The unit adjacent to the caret in the current group: the sibling that ENDS
  // at the caret (backward) or STARTS at it (forward).
  const unit =
    direction === "backward"
      ? siblings.find((c) => c.span.end === offset)
      : siblings.find((c) => c.span.start === offset);

  if (unit) {
    // A scripted construct is one indivisible unit: the base and its scripts are
    // selected together (`x^{2}` ⇒ the whole `x^{2}`, base and `^{2}` alike), so
    // the first press highlights the lot and the next deletes it. This is just
    // the whole-node path below — supsub is not a leaf — so there is no special
    // case; the base+sup+sub merge falls out of treating the node as a whole.
    return {
      start: unit.span.start,
      end: unit.span.end,
      isConstruct: !isLeaf(unit),
    };
  }

  // Nothing at this level (caret at the group's edge): escalate to the enclosing
  // construct so the whole thing is the unit rather than its braces chipped off
  // into partial LaTeX. A caret inside an empty script slot is the exception —
  // there the unit is just that empty script, so it can be peeled off alone.
  if (parent) {
    return (
      emptyScriptUnit(parent, offset) ?? {
        start: parent.span.start,
        end: parent.span.end,
        isConstruct: !isLeaf(parent),
      }
    );
  }
  return null;
}

/**
 * Whether `offset` sits *inside* a multi-part construct (a fraction, root,
 * script, brace group, …) rather than at the top level of the formula. True
 * means a caret there is within one of the construct's slots, so the formula
 * cannot be cleanly broken in two at this point — splitting would divide the
 * construct into invalid LaTeX (`\frac{a` / `b}`). The top-level positions
 * *between* sibling tokens return false, as do positions inside a plain leaf
 * (a command name the caret can't rest within anyway).
 *
 * This is the structural counterpart the editor's inline-math split asks before
 * turning a typed space into a chip boundary: only top-level spaces split a chip.
 */
export function isInsideConstruct(latex: string, offset: number): boolean {
  if (offset <= 0 || offset >= latex.length) return false;
  const root = parse(latex);
  if (root.type !== "ord") return false;
  const { parent } = locate(root.body, offset, null);
  return parent !== null && !isLeaf(parent);
}

/**
 * Where a script (`^`/`_`) typed at `offset` should actually be inserted so it
 * attaches to the WHOLE enclosing accented construct instead of growing the
 * accent's base. A non-stretchy accent (`\dot{x}`, `\vec{v}`) decorates one
 * symbol — it reads as a single construct — so a script typed at the end of its
 * base slot (`\dot{x|}`, the position live editing lands the caret at after
 * filling the materialized `\dot{}`) means "script the accented atom"
 * (`\dot{x}^{2}`), not "expand the base under the accent" (`\dot{x^{2}}`).
 *
 * Returns the source offset just past the outermost such construct — nested
 * accents escalate, so `\hat{\dot{x|}}` resolves to after the whole `\hat{…}` —
 * or `null` when the caret isn't at the end of a non-stretchy accent's braced,
 * non-empty base. Stretchy accents (`\widehat`, `\widetilde`) never redirect:
 * their whole point is to span arbitrary content, so a script typed inside
 * stays inside. Pure; the editor consults this before inserting a script char.
 */
export function scriptAttachOffset(
  latex: string,
  offset: number,
): number | null {
  const root = parse(latex);
  if (root.type !== "ord") return null;

  let target: number | null = null;
  let cursor = offset;
  for (;;) {
    const hop = accentEndHop(root, cursor, latex);
    if (hop === null) break;
    target = hop;
    cursor = hop;
  }
  return target;
}

/**
 * The offset just past a non-stretchy accent whose braced, non-empty base ends
 * exactly at `offset` (i.e. the caret sits right before the base's closing
 * brace), or `null`. The `latex[offset] === "}"` guard skips an unterminated
 * base (`\dot{x`), whose span ends without a brace to hop over.
 */
function accentEndHop(
  node: Node,
  offset: number,
  latex: string,
): number | null {
  if (
    node.type === "accent" &&
    !node.stretchy &&
    node.base.type === "ord" &&
    node.base.body.length > 0 &&
    offset === node.base.span.end - 1 &&
    latex[offset] === "}"
  ) {
    return node.span.end;
  }
  for (const group of childGroups(node)) {
    for (const child of group) {
      const hop = accentEndHop(child, offset, latex);
      if (hop !== null) return hop;
    }
  }
  return null;
}

/**
 * The editing unit immediately before `offset` — what a Backspace there acts on.
 * `null` at the very start (`offset <= 0`).
 */
export function unitBefore(latex: string, offset: number): MathUnit | null {
  return resolve(latex, offset, "backward");
}

/**
 * The editing unit immediately after `offset` — what a forward-Delete there acts
 * on. `null` at the very end (`offset >= latex.length`).
 */
export function unitAfter(latex: string, offset: number): MathUnit | null {
  return resolve(latex, offset, "forward");
}

/**
 * Resolve the unit a pointer double-click/double-tap at `offset` selects, on the
 * given side of the boundary. Where {@link resolve} (Backspace/Delete) takes the
 * single editable LEAF beside the caret, a double-click means "select the whole
 * thing I'm pointing at": a leaf that lives inside a construct escalates to that
 * construct, so clicking any glyph of a fraction's numerator selects the entire
 * `\frac`, a script base selects the whole `x^{2}`. A leaf at the TOP level has
 * no enclosing construct, so it stays its own token (`\alpha`, a bare `a`) rather
 * than widening to swallow its neighbours. `null` past the source boundary.
 */
function resolveSelection(
  latex: string,
  offset: number,
  direction: Direction,
): MathUnit | null {
  if (direction === "backward" ? offset <= 0 : offset >= latex.length) {
    return null;
  }

  const root = parse(latex);
  if (root.type !== "ord") return null;

  const { siblings, parent } = locate(root.body, offset, null);
  const unit =
    direction === "backward"
      ? siblings.find((c) => c.span.end === offset)
      : siblings.find((c) => c.span.start === offset);

  // A leaf sitting inside a construct selects that whole construct; a leaf at the
  // top level (no enclosing construct) is its own token; a construct selects
  // itself. With no adjacent unit (caret at a group edge) escalate to the
  // enclosing construct — the same edge case {@link resolve} handles.
  const target = unit && !(isLeaf(unit) && parent) ? unit : parent;
  if (!target) return null;
  return {
    start: target.span.start,
    end: target.span.end,
    isConstruct: !isLeaf(target),
  };
}

/**
 * The structural unit a double-click / double-tap at source `offset` selects: the
 * construct under the pointer, whole (see {@link resolveSelection}). The pointer
 * hit-test resolves a click to a glyph EDGE, so the glyph actually under the
 * cursor may be on either side; we resolve each side and prefer the one that is a
 * construct, so a boundary between a `\frac` and a neighbouring `+` selects the
 * fraction, not the operator. `null` for an empty formula.
 */
export function unitAt(latex: string, offset: number): MathUnit | null {
  const before = resolveSelection(latex, offset, "backward");
  const after = resolveSelection(latex, offset, "forward");
  return [before, after].find((u) => u?.isConstruct) ?? after ?? before;
}
