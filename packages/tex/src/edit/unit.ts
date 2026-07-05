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
 * A single code point of a `\text{…}` run as the editing unit adjacent to the
 * caret. A text run is one AST node (it has no child nodes to descend into), but
 * its {@link TextNode.charSpans} give every code point its own source range, so a
 * Backspace/Delete inside the run peels ONE character rather than escalating to
 * wipe the whole run. Works uniformly for native-glyph text and the host-shaped
 * fallback runs (CJK, Arabic, …): the spans are logical-order source ranges, so
 * an RTL run deletes the logically-adjacent char (Backspace removes the char
 * *before* the caret in source order, whatever its screen side). `null` at a run
 * edge (caret at the body's first-char start for Backspace / last-char end for
 * Delete) so the caller escalates to the whole `\text{…}` there.
 */
function textCharUnit(
  node: Node,
  offset: number,
  direction: Direction,
): MathUnit | null {
  if (node.type !== "text") return null;
  const span =
    direction === "backward"
      ? node.charSpans.find((s) => s.end === offset)
      : node.charSpans.find((s) => s.start === offset);
  return span ? { start: span.start, end: span.end, isConstruct: false } : null;
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
  // into partial LaTeX. Two exceptions peel a smaller piece: a caret inside an
  // empty script slot takes just that empty script, and a caret inside a
  // `\text{…}` run takes the single code point beside it (so text is edited one
  // char at a time, not wiped whole) — both fall back to the construct at a run
  // edge where no smaller unit resolves.
  if (parent) {
    return (
      emptyScriptUnit(parent, offset) ??
      textCharUnit(parent, offset, direction) ?? {
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
 * Where a script (`script`, `^` or `_`) typed at `offset` should actually be
 * inserted so it attaches to the WHOLE enclosing construct instead of nesting
 * inside the slot the caret happens to sit in. Two constructs redirect:
 *
 *  - **A non-stretchy accent** (`\dot{x}`, `\vec{v}`) decorates one symbol — it
 *    reads as a single construct — so a script typed at the end of its base slot
 *    (`\dot{x|}`, where live editing lands the caret after filling the
 *    materialized `\dot{}`) means "script the accented atom" (`\dot{x}^{2}`), not
 *    "expand the base under the accent" (`\dot{x^{2}}`). Stretchy accents
 *    (`\widehat`, `\widetilde`) never redirect: their whole point is to span
 *    arbitrary content, so a script typed inside stays inside.
 *
 *  - **A super/subscript** whose complementary slot is still free. After typing a
 *    subscript the caret rests at the end of its slot (`x_{n|}`); the natural next
 *    gesture — a `^` to add the matching superscript — must attach to the SAME
 *    base (`x_{n}^{2}`, one construct with both scripts), not nest into the
 *    subscript's content (`x_{n^{2}}`). So a script typed at the end of a
 *    supsub's braced, non-empty script slot redirects past the whole supsub —
 *    but ONLY when the supsub lacks the script being added (typing `^` while a
 *    superscript already exists can't add a second, so it falls through and
 *    stays inside the slot).
 *
 * Returns the source offset just past the outermost such construct — nested
 * constructs escalate, so `\hat{\dot{x|}}` resolves to after the whole `\hat{…}`
 * — or `null` when the caret isn't at a redirecting construct's slot end. Pure;
 * the editor consults this before inserting a script char.
 */
export function scriptAttachOffset(
  latex: string,
  offset: number,
  script: "^" | "_",
): number | null {
  const root = parse(latex);
  if (root.type !== "ord") return null;

  let target: number | null = null;
  let cursor = offset;
  for (;;) {
    const hop = scriptEndHop(root, cursor, latex, script);
    if (hop === null) break;
    target = hop;
    cursor = hop;
  }
  return target;
}

/**
 * The offset just past a construct whose braced, non-empty slot ends exactly at
 * `offset` (the caret sits right before that slot's closing brace) and that a
 * script typed there should attach to as a whole, or `null`. Covers a
 * non-stretchy accent's base and a super/subscript's script slot (see
 * {@link scriptAttachOffset}). The `latex[offset] === "}"` guard skips an
 * unterminated slot (`\dot{x`), whose span ends without a brace to hop over.
 */
function scriptEndHop(
  node: Node,
  offset: number,
  latex: string,
  script: "^" | "_",
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
  if (node.type === "supsub") {
    // Adding the script only makes sense when the matching slot is still empty —
    // LaTeX has no second superscript, so `x^{2|}` + `^` can't escalate and must
    // stay put (the parser would drop the duplicate `^{}` anyway).
    const free = script === "^" ? node.sup === null : node.sub === null;
    if (free) {
      for (const slot of [node.sup, node.sub]) {
        if (
          slot &&
          slot.type === "ord" &&
          slot.body.length > 0 &&
          offset === slot.span.end - 1 &&
          latex[offset] === "}"
        ) {
          return node.span.end;
        }
      }
    }
  }
  for (const group of childGroups(node)) {
    for (const child of group) {
      const hop = scriptEndHop(child, offset, latex, script);
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

/** One nesting level of the AST as seen along a descent to a source offset. */
interface SelectionLevel {
  /** Source span of the slot's content (its sibling list's extent). */
  readonly start: number;
  readonly end: number;
  /** The construct owning this slot, or `null` for the formula's top level. */
  readonly construct: Node | null;
}

/**
 * The chain of nesting levels from the formula's top level down to the slot that
 * *strictly* contains `offset`, each carrying the construct it belongs to. The
 * root level (construct `null`) is always first; a caret inside a fraction's
 * numerator yields `[root, frac.num]`; one inside a nested fraction yields three.
 * Mirrors {@link locate}'s descent, but records the whole path rather than only
 * the innermost group — range selection needs to compare two offsets' levels.
 */
function levelsAt(root: Node, offset: number): SelectionLevel[] {
  const levels: SelectionLevel[] = [
    { start: root.span.start, end: root.span.end, construct: null },
  ];
  let siblings = root.type === "ord" ? root.body : [];
  descend: for (;;) {
    for (const child of siblings) {
      if (offset > child.span.start && offset < child.span.end) {
        for (const group of childGroups(child)) {
          if (group.length === 0) continue;
          const gStart = group[0].span.start;
          const gEnd = group[group.length - 1].span.end;
          if (offset >= gStart && offset <= gEnd) {
            levels.push({ start: gStart, end: gEnd, construct: child });
            siblings = group;
            continue descend;
          }
        }
        // Inside `child` but not within any populated slot (its delimiters or an
        // empty slot): it is atomic here. Record it as a terminal level so an
        // endpoint escalates to the whole construct instead of resting in its guts.
        levels.push({
          start: child.span.start,
          end: child.span.end,
          construct: child,
        });
        break descend;
      }
    }
    break;
  }
  return levels;
}

/**
 * Snap a range SELECTION's endpoints so it never partially covers a connected
 * construct — while staying LEVEL-AWARE: a selection lives at the deepest nesting
 * level the two endpoints share, and only constructs *below* that level are
 * atomic. Selecting within a fraction's numerator stays inside the numerator
 * (its own tokens are selectable); dragging from the numerator to the denominator
 * escalates to the whole `\frac`; at the top level a fraction is one unit.
 *
 * The two endpoints snap by different rules once the shared level is found:
 * - the `focus` (the endpoint just moved) that descends into a deeper construct
 *   snaps to that construct's edge in its DIRECTION OF TRAVEL (`focusEdge`) — far
 *   edge to take it in, near edge to drop it (this is what makes "select less"
 *   work);
 * - the `anchor` (fixed pivot) that descends deeper widens OUTWARD, to the far
 *   edge of its construct away from the focus, so the whole of it is covered.
 *
 * Offsets that already sit at the shared level are left untouched. Returns the
 * possibly-adjusted pair; a collapsed range (equal offsets) passes through.
 */
export function resolveSelectionRange(
  latex: string,
  anchor: number,
  focus: number,
  focusEdge: "start" | "end",
): { anchor: number; focus: number } {
  if (anchor === focus) return { anchor, focus };
  const root = parse(latex);
  if (root.type !== "ord") return { anchor, focus };

  const pathA = levelsAt(root, anchor);
  const pathF = levelsAt(root, focus);

  // Deepest level whose slot (identified by its content span) both endpoints
  // share. The root level always matches, so `k` starts there and descends while
  // the next level down is the same slot in both paths.
  let k = 0;
  const maxK = Math.min(pathA.length, pathF.length) - 1;
  while (
    k < maxK &&
    pathA[k + 1].start === pathF[k + 1].start &&
    pathA[k + 1].end === pathF[k + 1].end
  ) {
    k++;
  }

  const forward = anchor < focus;
  // Anchor: if it lives below the shared level, take the whole child it sits in,
  // widening away from the focus (start when the anchor is the low end, else end).
  let outAnchor = anchor;
  if (k + 1 < pathA.length) {
    const child = pathA[k + 1].construct!;
    outAnchor = forward ? child.span.start : child.span.end;
  }
  // Focus: if it lives below the shared level, snap to its child's edge in the
  // direction the focus travelled.
  let outFocus = focus;
  if (k + 1 < pathF.length) {
    const child = pathF[k + 1].construct!;
    outFocus = focusEdge === "end" ? child.span.end : child.span.start;
  }
  return { anchor: outAnchor, focus: outFocus };
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
  // Level-aware, like the caret: {@link resolveSelection} escalates a leaf to the
  // CLOSEST enclosing construct, never further, so a click respects the nesting it
  // lands in. A radical is one such construct — tapping a bare radicand takes the
  // whole `\sqrt{…}` (its surd/vinculum have no source of their own, so a leaf
  // there escalates to the root), but a nested construct filling the radicand (an
  // inner `\frac`, a matrix) is the closer level and wins, so the double-click
  // grabs that inner construct rather than ballooning to the whole radical. The
  // box-tree point path (`spanAtPoint`) matches this via {@link ListBox.radical}.
  const before = resolveSelection(latex, offset, "backward");
  const after = resolveSelection(latex, offset, "forward");
  return [before, after].find((u) => u?.isConstruct) ?? after ?? before;
}
