/**
 * Pure editing commands for a structured math attachment.
 *
 * This module deliberately has no dependency on editor state, canvas nodes, or
 * the shared selection model. A host resolves its selection to a
 * {@link MathTreeCaret}, emits the returned generic structured edits through
 * its normal `content_edit` operation envelope, and stores the returned caret.
 *
 * Carets use CRDT identities instead of offsets. A row caret identifies a gap
 * after a sibling; a text caret identifies a gap after a character. They
 * therefore survive unrelated inserts without being numerically rebased.
 */

import type { Char } from "../serlization/loadPage";
import { charsToRuns, iterateAllChars } from "../sync/char-runs";
import {
  generateKeyBetween,
  generateNKeysBetween,
} from "../sync/fractional-index";
import {
  extractCounter,
  type IdentityAllocator,
  parseAllocatedIdentity,
} from "../sync/id";
import {
  applyStructuredEdits,
  getStructuredChildren,
  getStructuredText,
  type StructuredDocument,
  type StructuredEdit,
  type StructuredNode,
} from "../sync/structured-content";
import {
  MATH_STRUCTURED_KIND,
  mathDocumentToStructured,
  validateStructuredMathDocument,
} from "./structured";
import { parseMathDocument } from "@cypherkit/tex/data";

/** A stable gap inside a math row. `null` means before its first child. */
export interface MathRowCaret {
  readonly kind: "row";
  readonly rowId: string;
  readonly afterNodeId: string | null;
}

/** A stable gap inside the editable field of one raw-text leaf. */
export interface MathTextCaret {
  readonly kind: "text";
  readonly rowId: string;
  readonly nodeId: string;
  readonly field: "text";
  /** `null` means before the field's first character. */
  readonly afterCharId: string | null;
}

/** Feature-local caret used by the pure tree controller. */
export type MathTreeCaret = MathRowCaret | MathTextCaret;

/** A directional selection expressed entirely with stable tree identities. */
export interface MathTreeRange {
  readonly anchor: MathTreeCaret;
  readonly focus: MathTreeCaret;
}

/**
 * Select-first range for a composite construct adjacent to a collapsed caret.
 *
 * Raw text and atomic leaves keep their one-key deletion behavior. Fractions,
 * radicals, scripts, delimiters, and matrices are large visual constructs, so
 * Backspace/Delete first exposes exactly what a second press will remove.
 */
export function adjacentMathTreeConstructRange(
  document: StructuredDocument,
  caret: MathTreeCaret,
  direction: "backward" | "forward",
): MathTreeRange | null {
  const math = validMathDocument(document);
  if (!math) return null;
  const resolved = resolveCaret(math, caret);
  if (!resolved) return null;

  let gap: MathRowCaret | null;
  if (resolved.kind === "row") {
    gap = caret as MathRowCaret;
  } else if (direction === "backward") {
    if (resolved.position > 0) return null;
    gap = gapBeforeNode(math, resolved.row.id, resolved.node.id) ?? null;
  } else {
    if (resolved.position < resolved.visibleCharacters.length) return null;
    gap = rowCaret(resolved.row.id, resolved.node.id);
  }
  if (!gap) return null;

  const at = resolveCaret(math, gap);
  if (!at || at.kind !== "row") return null;
  const children = getStructuredChildren(math, at.row.id, "children");
  const index = direction === "backward" ? at.position - 1 : at.position;
  const construct = children[index];
  if (!construct || !isCompositeMathConstruct(construct)) return null;

  return {
    anchor: rowCaret(at.row.id, children[index - 1]?.id ?? null),
    focus: rowCaret(at.row.id, construct.id),
  };
}

/**
 * Identity allocation is deliberately feature-agnostic.
 *
 * Live commands receive the page's CRDT binding directly. Imports and tests
 * may use a generic deterministic allocator with a unique document scope.
 * Node and character ids share the allocator, so a future structured block
 * does not need its own `createXIdGenerator` API or parallel namespaces.
 */

export type MathTreeMotion = "tab" | "shift-tab" | "arrow-right" | "arrow-left";

export type MathTreeEditFailure =
  | "not-math-document"
  | "invalid-caret"
  | "unsupported-position"
  | "unsupported-cross-slot-range"
  | "invalid-identity"
  | "identity-collision"
  | "invalid-semantic-source"
  | "no-matrix-target"
  | "no-command"
  | "no-navigation-target";

export interface MathTreeEditResult {
  /** Whether this controller consumed the requested input/navigation. */
  readonly handled: boolean;
  /** Generic mutations to send in this exact order. */
  readonly edits: readonly StructuredEdit[];
  /** Identity-based caret after all returned edits have been applied. */
  readonly caret: MathTreeCaret;
  readonly reason?: MathTreeEditFailure;
  readonly completedCommand?: string;
}

/** Semantic template returned when one literal command is safe to commit. */
export interface MathCommandCompletion {
  readonly id: string;
  readonly latex: string;
}

/** Host vocabulary seam; the pure tree editor does not import UI catalogs. */
export type MathCommandCompletionResolver = (
  command: string,
  following?: string,
) => MathCommandCompletion | undefined;

export interface MathSemanticInsertionOptions {
  /** Command templates enter their first slot; paste/IME normally land at end. */
  readonly caret?: "first-slot" | "end";
  /** Preserve parser-droppable committed source as one exact atomic fallback. */
  readonly forceAtomic?: boolean;
}

export interface MathTreeMatrixContext {
  readonly matrixId: string;
  readonly matrixRowId: string;
  readonly cellId: string;
  readonly bodyRowId: string;
  readonly rows: number;
  readonly cols: number;
  readonly row: number;
  readonly col: number;
}

export type MathTreeRangeTextResult =
  | { readonly handled: true; readonly text: string }
  | {
      readonly handled: false;
      readonly text: "";
      readonly reason: MathTreeEditFailure;
    };

/**
 * Expand range endpoints that cut through an exact recognized command token.
 * Incomplete command scratch stays character-editable; once `\\sin` is exact,
 * selecting `si` can only remove the whole source token, never leave `\\n`.
 */
export function expandMathTreeRangeToAtomicCommands(
  document: StructuredDocument,
  range: MathTreeRange,
  resolveCommand: MathCommandCompletionResolver,
): MathTreeRange {
  const math = validMathDocument(document);
  if (!math) return range;
  const anchor = resolveRangeEndpoint(math, range.anchor);
  const focus = resolveRangeEndpoint(math, range.focus);
  if (!anchor || !focus || anchor.resolved.row.id !== focus.resolved.row.id) {
    return range;
  }
  const anchorFirst = compareRangeEndpoints(anchor, focus) <= 0;
  const start = anchorFirst ? anchor : focus;
  const end = anchorFirst ? focus : anchor;
  const expandedStart = expandAtomicEndpoint(start, "start", resolveCommand);
  const expandedEnd = expandAtomicEndpoint(end, "end", resolveCommand);
  return anchorFirst
    ? { anchor: expandedStart, focus: expandedEnd }
    : { anchor: expandedEnd, focus: expandedStart };
}

interface VisibleCharacter {
  readonly id: string;
  readonly char: string;
}

interface ResolvedRowCaret {
  readonly kind: "row";
  readonly row: StructuredNode;
  readonly position: number;
}

interface ResolvedTextCaret {
  readonly kind: "text";
  readonly row: StructuredNode;
  readonly node: StructuredNode;
  readonly allCharacters: readonly {
    readonly id: string;
    readonly char: string;
    readonly deleted: boolean;
  }[];
  readonly visibleCharacters: readonly VisibleCharacter[];
  readonly position: number;
}

type ResolvedCaret = ResolvedRowCaret | ResolvedTextCaret;

interface SemanticInsertionSite {
  readonly gap: MathRowCaret;
  /** A middle-of-leaf splice retains the left run and clones this right run. */
  readonly split?: {
    readonly source: StructuredNode;
    readonly characters: readonly VisibleCharacter[];
  };
}

interface ResolvedRangeEndpoint {
  readonly caret: MathTreeCaret;
  readonly resolved: ResolvedCaret;
  /** Visible child index for a text leaf, or visible gap index for a row gap. */
  readonly childIndex: number;
}

interface ResolvedOrderedRange {
  readonly row: StructuredNode;
  readonly children: readonly StructuredNode[];
  readonly start: ResolvedRangeEndpoint;
  readonly end: ResolvedRangeEndpoint;
}

type ResolveRangeResult =
  | { readonly ok: true; readonly range: ResolvedOrderedRange }
  | {
      readonly ok: false;
      readonly reason: "invalid-caret" | "unsupported-cross-slot-range";
    };

interface FractionSlot {
  readonly fraction: StructuredNode;
  readonly row: StructuredNode;
  readonly slot: "numerator" | "denominator";
}

/** Insert literal math text at a row gap or inside a raw-text leaf. */
export function insertMathText(
  document: StructuredDocument,
  caret: MathTreeCaret,
  text: string,
  identities: IdentityAllocator,
  caretOffset = text.length,
): MathTreeEditResult {
  const math = validMathDocument(document);
  if (!math) return failure(caret, "not-math-document");
  const resolved = resolveCaret(math, caret);
  if (!resolved) return failure(caret, "invalid-caret");
  if (text.length === 0) return success(caret, []);
  const requestedCaretOffset = Number.isFinite(caretOffset)
    ? Math.trunc(caretOffset)
    : text.length;
  const clampedCaretOffset = Math.max(
    0,
    Math.min(text.length, requestedCaretOffset),
  );

  if (resolved.kind === "row") {
    const placement = placementAtGap(math, caret as MathRowCaret);
    if (!placement) return failure(caret, "invalid-caret");

    const existingIds = collectDocumentIdentities(math);
    const nodeId = identities.nextId();
    const nodeFailure = acceptNodeIdentity(nodeId, existingIds);
    if (nodeFailure) return failure(caret, nodeFailure);
    existingIds.add(nodeId);

    const characters = mintCharacters(text, identities, existingIds);
    if (!characters.ok) return failure(caret, characters.reason);

    const edit: StructuredEdit = {
      kind: "node_insert",
      node: {
        id: nodeId,
        type: "raw-text",
        placement,
        attrs: {},
        textFields: { text: charsToRuns(characters.chars) },
      },
    };
    return success(
      textCaret(
        resolved.row.id,
        nodeId,
        characters.chars[clampedCaretOffset - 1]?.id ?? null,
      ),
      [edit],
    );
  }

  const existingIds = collectDocumentIdentities(math);
  const characters = mintCharacters(text, identities, existingIds);
  if (!characters.ok) return failure(caret, characters.reason);

  // Emit one insertion per character. This preserves arbitrary injected ids;
  // a single RGA insertion run requires one peer and contiguous counters.
  const edits: StructuredEdit[] = [];
  let afterCharId = (caret as MathTextCaret).afterCharId;
  for (const char of characters.chars) {
    edits.push({
      kind: "text_insert",
      nodeId: resolved.node.id,
      field: "text",
      afterCharId,
      charRuns: charsToRuns([char]),
    });
    afterCharId = char.id;
  }
  return success(
    textCaret(
      resolved.row.id,
      resolved.node.id,
      clampedCaretOffset === 0
        ? (caret as MathTextCaret).afterCharId
        : characters.chars[clampedCaretOffset - 1].id,
    ),
    edits,
  );
}

/**
 * Insert an ordinary `\frac` structure and enter its numerator.
 *
 * A text caret is accepted at either edge of its raw-text leaf. Inserting a
 * structure in the middle of a leaf is intentionally not handled by this
 * first slice: doing so safely needs a CRDT-preserving leaf split operation.
 */
export function insertMathFraction(
  document: StructuredDocument,
  caret: MathTreeCaret,
  identities: IdentityAllocator,
): MathTreeEditResult {
  const math = validMathDocument(document);
  if (!math) return failure(caret, "not-math-document");
  const resolved = resolveCaret(math, caret);
  if (!resolved) return failure(caret, "invalid-caret");

  const gap = structuralGapForCaret(math, caret, resolved);
  if (!gap) return failure(caret, "unsupported-position");
  const result = insertFractionAtGap(math, gap, identities);
  return result.handled ? result : { ...result, caret };
}

/**
 * Parse a committed LaTeX construct and splice its semantic subtree at a row
 * gap. This is the command-menu boundary: supported constructs such as
 * radicals, scripts, delimiters, matrices, operators, and named symbols enter
 * the CRDT as their typed nodes, never as editable command/bracket characters
 * inside a `raw-text` leaf. Parser fallbacks remain one atomic `raw-latex`
 * node, preserving unsupported source without exposing its syntax piecemeal.
 *
 * A text caret in the middle of a leaf performs a stable split: the original
 * leaf retains its left-hand identity, a fresh right leaf preserves the source
 * suffix, and the semantic subtree is ordered between them. The returned caret
 * enters the construct's first useful empty slot (numerator, radicand, script,
 * delimited body, or matrix cell), or lands after an atomic construct.
 */
export function insertMathSemanticLatex(
  document: StructuredDocument,
  caret: MathTreeCaret,
  latex: string,
  identities: IdentityAllocator,
  options: MathSemanticInsertionOptions = {},
): MathTreeEditResult {
  const math = validMathDocument(document);
  if (!math) return failure(caret, "not-math-document");
  const resolved = resolveCaret(math, caret);
  if (!resolved) return failure(caret, "invalid-caret");
  if (latex.length === 0) return success(caret, []);

  const site = semanticInsertionSite(math, caret, resolved);
  if (!site) return failure(caret, "unsupported-position");
  if (!placementsAtGap(math, site.gap, 1)) {
    return failure(caret, "invalid-caret");
  }

  const guarded = guardIdentityAllocator(math, identities);
  let fragment: StructuredDocument;
  try {
    const nested = options.forceAtomic
      ? atomicMathDocument(latex, guarded.identities)
      : parseMathDocument(latex, {
          identityAllocator: guarded.identities,
        });
    fragment = mathDocumentToStructured(nested, {
      identityAllocator: guarded.identities,
    });
  } catch {
    return failure(caret, guarded.reason() ?? "invalid-semantic-source");
  }

  const body = onlyChild(fragment, fragment.rootId, "body", "row");
  if (!body) return failure(caret, "invalid-semantic-source");
  const children = getStructuredChildren(fragment, body.id, "children");
  if (children.length === 0) return success(caret, []);

  let rightLeaf:
    | {
        readonly id: string;
        readonly characters: readonly Char[];
      }
    | undefined;
  if (site.split) {
    try {
      const id = guarded.identities.nextId();
      const characters = site.split.characters.map(({ char }) => ({
        id: guarded.identities.nextId(),
        char,
      }));
      rightLeaf = { id, characters };
    } catch {
      return failure(caret, guarded.reason() ?? "invalid-semantic-source");
    }
  }

  const targetPlacements = placementsAtGap(
    math,
    site.gap,
    children.length + (rightLeaf ? 1 : 0),
  );
  if (!targetPlacements) return failure(caret, "invalid-caret");
  const edits: StructuredEdit[] = [];
  if (site.split) {
    edits.push({
      kind: "text_delete",
      nodeId: site.split.source.id,
      field: "text",
      charIds: site.split.characters.map(({ id }) => id),
    });
  }
  edits.push(
    ...semanticSubtreeInsertions(
      fragment,
      children,
      targetPlacements.slice(0, children.length),
    ),
  );
  if (rightLeaf) {
    edits.push({
      kind: "node_insert",
      node: {
        id: rightLeaf.id,
        type: "raw-text",
        placement: targetPlacements.at(-1)!,
        attrs: {},
        textFields: { text: charsToRuns([...rightLeaf.characters]) },
      },
    });
  }
  const insertedCaret =
    options.caret === "end"
      ? rowCaret(site.gap.rowId, children.at(-1)!.id)
      : preferredInsertedCaret(fragment, site.gap.rowId, children);
  return success(insertedCaret, edits);
}

/** Replace one supported same-row range with a committed semantic construct. */
export function replaceMathTreeRangeWithSemanticLatex(
  document: StructuredDocument,
  range: MathTreeRange,
  latex: string,
  identities: IdentityAllocator,
  options: MathSemanticInsertionOptions = {},
): MathTreeEditResult {
  const deleted = deleteMathTreeRange(document, range);
  if (!deleted.handled) return deleted;
  if (latex.length === 0) return deleted;

  const afterDelete = applyStructuredEdits(document, deleted.edits);
  const inserted = insertMathSemanticLatex(
    afterDelete,
    deleted.caret,
    latex,
    identities,
    options,
  );
  if (!inserted.handled) return { ...inserted, caret: range.focus };
  return success(inserted.caret, [...deleted.edits, ...inserted.edits]);
}

/** Resolve the identity-bearing matrix cell containing one tree caret. */
export function getMathTreeMatrixContext(
  document: StructuredDocument,
  caret: MathTreeCaret,
): MathTreeMatrixContext | undefined {
  const math = validMathDocument(document);
  if (!math) return undefined;
  const resolved = resolveCaret(math, caret);
  if (!resolved) return undefined;
  const body = resolved.row;
  const cellId = body.placement.parentId;
  const cell = cellId ? math.nodes[cellId] : undefined;
  const matrixRowId = cell?.placement.parentId;
  const matrixRow = matrixRowId ? math.nodes[matrixRowId] : undefined;
  const matrixId = matrixRow?.placement.parentId;
  const matrix = matrixId ? math.nodes[matrixId] : undefined;
  if (
    !cell ||
    cell.deleted ||
    cell.type !== "matrix-cell" ||
    body.placement.slot !== "body" ||
    cell.placement.slot !== "cells" ||
    !matrixRow ||
    matrixRow.deleted ||
    matrixRow.type !== "matrix-row" ||
    matrixRow.placement.slot !== "rows" ||
    !matrix ||
    matrix.deleted ||
    matrix.type !== "matrix"
  ) {
    return undefined;
  }
  const rows = getStructuredChildren(math, matrix.id, "rows");
  const row = rows.findIndex((candidate) => candidate.id === matrixRow.id);
  const cells = getStructuredChildren(math, matrixRow.id, "cells");
  const col = cells.findIndex((candidate) => candidate.id === cell.id);
  if (row < 0 || col < 0) return undefined;
  return {
    matrixId: matrix.id,
    matrixRowId: matrixRow.id,
    cellId: cell.id,
    bodyRowId: body.id,
    rows: rows.length,
    cols: rows.reduce(
      (maximum, candidate) =>
        Math.max(
          maximum,
          getStructuredChildren(math, candidate.id, "cells").length,
        ),
      0,
    ),
    row,
    col,
  };
}

/**
 * Editing caret for a matrix target represented either by an interior caret or
 * by a same-row range holding the whole construct — the select-first range, or
 * a mouse drag whose endpoints rest a step outside the parentheses.
 */
export function mathTreeMatrixTargetCaret(
  document: StructuredDocument,
  caret: MathTreeCaret,
  range?: MathTreeRange,
): MathTreeCaret {
  if (getMathTreeMatrixContext(document, caret) || !range) return caret;
  const math = validMathDocument(document);
  if (!math) return caret;
  const anchor = resolveCaret(math, range.anchor);
  const focus = resolveCaret(math, range.focus);
  if (!anchor || !focus || anchor.row.id !== focus.row.id) return caret;
  const children = getStructuredChildren(math, anchor.row.id, "children");
  // Child-gap bounds of one endpoint. A drag endpoint may rest inside a text
  // run rather than on a child gap; a matrix can never hide inside a run, so
  // widening such an endpoint to the run's own boundaries only ever adds that
  // run — never a sibling — to the sweep.
  const gapBounds = (
    resolved: NonNullable<ReturnType<typeof resolveCaret>>,
  ): { start: number; end: number } | undefined => {
    if (resolved.kind === "row") {
      return { start: resolved.position, end: resolved.position };
    }
    const index = children.findIndex((node) => node.id === resolved.node.id);
    return index < 0 ? undefined : { start: index, end: index + 1 };
  };
  const anchorBounds = gapBounds(anchor);
  const focusBounds = gapBounds(focus);
  if (!anchorBounds || !focusBounds) return caret;
  const matrix = children
    .slice(
      Math.min(anchorBounds.start, focusBounds.start),
      Math.max(anchorBounds.end, focusBounds.end),
    )
    .find((node) => node.type === "matrix");
  if (!matrix) return caret;
  const matrixRow = getStructuredChildren(math, matrix.id, "rows")[0];
  const cell = matrixRow
    ? getStructuredChildren(math, matrixRow.id, "cells")[0]
    : undefined;
  const body = cell ? onlyChild(math, cell.id, "body", "row") : undefined;
  return body ? rowCaret(body.id, null) : caret;
}

/**
 * Resize the active matrix with node-level CRDT edits.
 *
 * Surviving rows, cells, body rows, and all of their text keep their identities.
 * Growth appends fresh matrix-row/matrix-cell/row nodes; shrinkage tombstones
 * only trailing rows/cells. No source projection or LaTeX rewrite participates.
 */
export function resizeMathTreeMatrix(
  document: StructuredDocument,
  caret: MathTreeCaret,
  nextRows: number,
  nextCols: number,
  identities: IdentityAllocator,
): MathTreeEditResult {
  const math = validMathDocument(document);
  if (!math) return failure(caret, "not-math-document");
  const context = getMathTreeMatrixContext(math, caret);
  if (!context) return failure(caret, "no-matrix-target");
  const matrix = math.nodes[context.matrixId];
  const rows = getStructuredChildren(math, context.matrixId, "rows");
  const rowCount = rows.length;
  const colCount = context.cols;
  if (!matrix || rowCount === 0 || colCount === 0) {
    return failure(caret, "no-matrix-target");
  }
  const targetRows = finiteMatrixDimension(nextRows, rowCount);
  const targetCols = finiteMatrixDimension(nextCols, colCount);
  if (targetRows === rowCount && targetCols === colCount) {
    return success(caret, []);
  }

  const guarded = guardIdentityAllocator(math, identities);
  const edits: StructuredEdit[] = [];
  const bodyByCoordinate = new Map<string, string>();
  for (
    let rowIndex = 0;
    rowIndex < Math.min(rowCount, targetRows);
    rowIndex++
  ) {
    const matrixRow = rows[rowIndex];
    const cells = getStructuredChildren(math, matrixRow.id, "cells");
    for (
      let colIndex = 0;
      colIndex < Math.min(cells.length, targetCols);
      colIndex++
    ) {
      const body = onlyChild(math, cells[colIndex].id, "body", "row");
      if (body) bodyByCoordinate.set(`${rowIndex}:${colIndex}`, body.id);
    }
    if (cells.length > targetCols) {
      for (const cell of cells.slice(targetCols)) {
        edits.push({ kind: "node_delete", nodeId: cell.id });
      }
    } else if (cells.length < targetCols) {
      const placements = appendPlacements(
        math,
        matrixRow.id,
        "cells",
        targetCols - cells.length,
      );
      try {
        placements.forEach((placement, offset) => {
          const colIndex = cells.length + offset;
          const cellId = guarded.identities.nextId();
          const bodyId = guarded.identities.nextId();
          bodyByCoordinate.set(`${rowIndex}:${colIndex}`, bodyId);
          edits.push(
            nodeInsertion(cellId, "matrix-cell", placement),
            nodeInsertion(bodyId, "row", {
              parentId: cellId,
              slot: "body",
              orderKey: generateKeyBetween(null, null),
            }),
          );
        });
      } catch {
        return failure(caret, guarded.reason() ?? "invalid-identity");
      }
    }
  }

  if (rowCount > targetRows) {
    for (const row of rows.slice(targetRows)) {
      edits.push({ kind: "node_delete", nodeId: row.id });
    }
  } else if (rowCount < targetRows) {
    const rowPlacements = appendPlacements(
      math,
      matrix.id,
      "rows",
      targetRows - rowCount,
    );
    try {
      rowPlacements.forEach((rowPlacement, rowOffset) => {
        const rowIndex = rowCount + rowOffset;
        const matrixRowId = guarded.identities.nextId();
        edits.push(nodeInsertion(matrixRowId, "matrix-row", rowPlacement));
        const cellKeys = generateNKeysBetween(null, null, targetCols);
        for (let colIndex = 0; colIndex < targetCols; colIndex++) {
          const cellId = guarded.identities.nextId();
          const bodyId = guarded.identities.nextId();
          bodyByCoordinate.set(`${rowIndex}:${colIndex}`, bodyId);
          edits.push(
            nodeInsertion(cellId, "matrix-cell", {
              parentId: matrixRowId,
              slot: "cells",
              orderKey: cellKeys[colIndex],
            }),
            nodeInsertion(bodyId, "row", {
              parentId: cellId,
              slot: "body",
              orderKey: generateKeyBetween(null, null),
            }),
          );
        }
      });
    } catch {
      return failure(caret, guarded.reason() ?? "invalid-identity");
    }
  }

  const alignment = matrix.attrs.columnAlignment;
  if (Array.isArray(alignment)) {
    const resized = Array.from({ length: targetCols }, (_, index) => {
      const value = alignment[index];
      return value === "l" || value === "r" || value === "c" ? value : "c";
    });
    edits.push({
      kind: "node_attr_set",
      nodeId: matrix.id,
      key: "columnAlignment",
      value: resized,
    });
  }

  const targetRow = Math.min(context.row, targetRows - 1);
  const targetCol = Math.min(context.col, targetCols - 1);
  const originalSurvives = context.row < targetRows && context.col < targetCols;
  const nextCaret = originalSurvives
    ? caret
    : bodyByCoordinate.has(`${targetRow}:${targetCol}`)
      ? rowCaret(bodyByCoordinate.get(`${targetRow}:${targetCol}`)!, null)
      : caret;
  return success(nextCaret, edits);
}

/**
 * Complete one trailing literal command through a caller-owned vocabulary.
 * The pure controller owns parsing/splicing, while an interactive host decides
 * when a command name is unambiguous in its catalog. The default preserves the
 * original standalone `\frac` behavior for headless consumers.
 */
export function completeMathCommand(
  document: StructuredDocument,
  caret: MathTreeCaret,
  identities: IdentityAllocator,
  resolveCommand: MathCommandCompletionResolver = defaultCommandCompletion,
): MathTreeEditResult {
  const math = validMathDocument(document);
  if (!math) return failure(caret, "not-math-document");
  const resolved = resolveCaret(math, caret);
  if (!resolved) return failure(caret, "invalid-caret");
  if (resolved.kind !== "text") return failure(caret, "no-command");

  const source = resolved.visibleCharacters
    .slice(0, resolved.position)
    .map((entry) => entry.char)
    .join("");
  const query = source.match(/\\([A-Za-z]+)$/);
  const completion = query ? resolveCommand(query[1]) : undefined;
  if (!query || !completion) return failure(caret, "no-command");
  const queryStart = resolved.position - query[0].length;
  const suffix = resolved.visibleCharacters.slice(
    queryStart,
    resolved.position,
  );
  const deletion: StructuredEdit[] = [
    {
      kind: "text_delete",
      nodeId: resolved.node.id,
      field: "text",
      charIds: suffix.map((entry) => entry.id),
    },
  ];
  if (resolved.visibleCharacters.length === suffix.length) {
    deletion.push({ kind: "node_delete", nodeId: resolved.node.id });
  }
  const afterDelete = applyStructuredEdits(math, deletion.slice(0, 1));
  const semantic = insertMathSemanticLatex(
    afterDelete,
    textCaret(
      resolved.row.id,
      resolved.node.id,
      resolved.visibleCharacters[queryStart - 1]?.id ?? null,
    ),
    completion.latex,
    identities,
  );
  if (!semantic.handled) return { ...semantic, caret };

  return {
    ...semantic,
    edits: [...deletion, ...semantic.edits],
    completedCommand: completion.id,
  };
}

/** Insert text, then run structural command completion against the new value. */
export function insertMathTextWithCompletion(
  document: StructuredDocument,
  caret: MathTreeCaret,
  text: string,
  identities: IdentityAllocator,
  resolveCommand: MathCommandCompletionResolver = defaultCommandCompletion,
): MathTreeEditResult {
  const inputCharacters = Array.from(text);
  if (inputCharacters.length > 1) {
    let currentDocument = document;
    let currentCaret = caret;
    const edits: StructuredEdit[] = [];
    let completedCommand: string | undefined;
    for (const character of inputCharacters) {
      const step = insertMathTextWithCompletion(
        currentDocument,
        currentCaret,
        character,
        identities,
        resolveCommand,
      );
      if (!step.handled) return { ...step, caret };
      edits.push(...step.edits);
      currentDocument = applyStructuredEdits(currentDocument, step.edits);
      currentCaret = step.caret;
      completedCommand = step.completedCommand ?? completedCommand;
    }
    return {
      handled: true,
      edits,
      caret: currentCaret,
      ...(completedCommand ? { completedCommand } : {}),
    };
  }

  if (text.length > 0) {
    const beforeInput = completeMathCommand(
      document,
      caret,
      identities,
      (command) => resolveCommand(command, text[0]),
    );
    if (beforeInput.handled) {
      const afterCompletion = applyStructuredEdits(document, beforeInput.edits);
      const insertedAfter = insertMathText(
        afterCompletion,
        beforeInput.caret,
        text,
        identities,
      );
      if (!insertedAfter.handled) {
        return { ...insertedAfter, caret };
      }
      return {
        ...insertedAfter,
        edits: [...beforeInput.edits, ...insertedAfter.edits],
        completedCommand: beforeInput.completedCommand,
      };
    }
  }

  const inserted = insertMathText(document, caret, text, identities);
  if (!inserted.handled || inserted.edits.length === 0) return inserted;

  const afterInsertion = applyStructuredEdits(document, inserted.edits);
  const completion = completeMathCommand(
    afterInsertion,
    inserted.caret,
    identities,
    resolveCommand,
  );
  if (!completion.handled) {
    return completion.reason === "no-command"
      ? inserted
      : { ...inserted, reason: completion.reason };
  }
  return {
    ...completion,
    edits: [...inserted.edits, ...completion.edits],
  };
}

function defaultCommandCompletion(
  command: string,
): MathCommandCompletion | undefined {
  return command === "frac"
    ? { id: "frac", latex: String.raw`\frac{}{}` }
    : undefined;
}

function atomicMathDocument(
  latex: string,
  identities: IdentityAllocator,
): ReturnType<typeof parseMathDocument> {
  return {
    version: 1,
    root: {
      type: "root",
      id: identities.nextId(),
      body: {
        type: "row",
        id: identities.nextId(),
        children: [{ type: "raw-latex", id: identities.nextId(), latex }],
      },
    },
  };
}

/**
 * Replace a range inside one raw-text leaf as a single ordered edit batch.
 *
 * This is the structured counterpart to a command palette replacing its typed
 * `\query`; {@link replaceMathTreeRange} is the broader same-row operation.
 * `caretOffset` is measured inside the replacement text and defaults to its
 * end.
 */
export function replaceMathTextRange(
  document: StructuredDocument,
  anchor: MathTextCaret,
  focus: MathTextCaret,
  text: string,
  identities: IdentityAllocator,
  caretOffset = text.length,
): MathTreeEditResult {
  return replaceMathTreeRange(
    document,
    { anchor, focus },
    text,
    identities,
    caretOffset,
  );
}

/**
 * Delete a normalized range without flattening structural siblings to source.
 *
 * The safe range domain is one math row: endpoints may be gaps in that row or
 * positions in any of its raw-text leaves. Whole siblings between the
 * endpoints are tombstoned, while endpoint leaves retain their node identity
 * and only tombstone the selected characters. A range crossing into another
 * row/slot is rejected explicitly.
 */
export function deleteMathTreeRange(
  document: StructuredDocument,
  range: MathTreeRange,
): MathTreeEditResult {
  const math = validMathDocument(document);
  if (!math) return failure(range.focus, "not-math-document");
  const ordered = resolveOrderedRange(math, range);
  if (!ordered.ok) return failure(range.focus, ordered.reason);

  return success(
    caretAtRangeStart(ordered.range),
    editsForOrderedRange(ordered.range),
  );
}

/** Replace one supported tree range as a single ordered deletion/insertion. */
export function replaceMathTreeRange(
  document: StructuredDocument,
  range: MathTreeRange,
  text: string,
  identities: IdentityAllocator,
  caretOffset = text.length,
): MathTreeEditResult {
  const deleted = deleteMathTreeRange(document, range);
  if (!deleted.handled) return deleted;
  if (text.length === 0) return deleted;

  const afterDelete = applyStructuredEdits(document, deleted.edits);
  const inserted = insertMathText(
    afterDelete,
    deleted.caret,
    text,
    identities,
    caretOffset,
  );
  if (!inserted.handled) return { ...inserted, caret: range.focus };
  return success(inserted.caret, [...deleted.edits, ...inserted.edits]);
}

/**
 * Extract literal source for a supported range of raw-text siblings.
 * Structural children are deliberately reported as unsupported: callers that
 * need their canonical LaTeX must use the math document printer rather than
 * pretending a generic text concatenation is lossless.
 */
export function getMathTreeRangeText(
  document: StructuredDocument,
  range: MathTreeRange,
): MathTreeRangeTextResult {
  const math = validMathDocument(document);
  if (!math) {
    return { handled: false, text: "", reason: "not-math-document" };
  }
  const ordered = resolveOrderedRange(math, range);
  if (!ordered.ok) {
    return { handled: false, text: "", reason: ordered.reason };
  }

  let text = "";
  for (let index = 0; index < ordered.range.children.length; index++) {
    const node = ordered.range.children[index];
    if (node.type === "raw-text") {
      const characters = visibleCharacters(node);
      const bounds = selectedTextBounds(
        ordered.range,
        index,
        characters.length,
      );
      if (bounds) {
        text += characters
          .slice(bounds.start, bounds.end)
          .map((entry) => entry.char)
          .join("");
      }
      continue;
    }
    if (isFullySelectedChild(ordered.range, index)) {
      return { handled: false, text: "", reason: "unsupported-position" };
    }
  }
  return { handled: true, text };
}

/** Resolve Tab/Shift-Tab and horizontal-arrow movement inside a fraction. */
export function moveMathTreeCaret(
  document: StructuredDocument,
  caret: MathTreeCaret,
  motion: MathTreeMotion,
): MathTreeEditResult {
  const math = validMathDocument(document);
  if (!math) return failure(caret, "not-math-document");
  const resolved = resolveCaret(math, caret);
  if (!resolved) return failure(caret, "invalid-caret");

  if (motion === "tab" || motion === "shift-tab") {
    const slot = fractionSlotForRow(math, resolved.row.id);
    if (!slot) return failure(caret, "no-navigation-target");
    const destination =
      motion === "tab"
        ? slot.slot === "numerator"
          ? fractionSlotCaret(math, slot.fraction.id, "denominator", "start")
          : caretAfterFraction(math, slot.fraction)
        : slot.slot === "denominator"
          ? fractionSlotCaret(math, slot.fraction.id, "numerator", "end")
          : caretBeforeFraction(math, slot.fraction);
    return destination
      ? success(destination, [])
      : failure(caret, "no-navigation-target");
  }

  const destination =
    motion === "arrow-right"
      ? moveCaretRight(math, caret, resolved)
      : moveCaretLeft(math, caret, resolved);
  return destination
    ? success(destination, [])
    : failure(caret, "no-navigation-target");
}

/** Delete one raw-text character or unwrap a fraction from an empty slot. */
export function backspaceMathTree(
  document: StructuredDocument,
  caret: MathTreeCaret,
  resolveCommand?: MathCommandCompletionResolver,
): MathTreeEditResult {
  const math = validMathDocument(document);
  if (!math) return failure(caret, "not-math-document");
  const resolved = resolveCaret(math, caret);
  if (!resolved) return failure(caret, "invalid-caret");

  if (resolved.kind === "text" && resolved.position > 0) {
    const atomic = atomicCommandDeletion(
      resolved,
      resolved.position - 1,
      resolveCommand,
    );
    if (atomic) return atomic;
    const deleted = resolved.visibleCharacters[resolved.position - 1];
    const previous = resolved.visibleCharacters[resolved.position - 2];
    return success(
      textCaret(resolved.row.id, resolved.node.id, previous?.id ?? null),
      [
        {
          kind: "text_delete",
          nodeId: resolved.node.id,
          field: "text",
          charIds: [deleted.id],
        },
      ],
    );
  }

  const gap =
    resolved.kind === "row"
      ? (caret as MathRowCaret)
      : gapBeforeNode(math, resolved.row.id, resolved.node.id);
  if (!gap) return failure(caret, "invalid-caret");
  return backspaceAtRowGap(math, gap, caret);
}

/** Delete the next raw-text character, or enter the next structural child. */
export function deleteForwardMathTree(
  document: StructuredDocument,
  caret: MathTreeCaret,
  resolveCommand?: MathCommandCompletionResolver,
): MathTreeEditResult {
  const math = validMathDocument(document);
  if (!math) return failure(caret, "not-math-document");
  const resolved = resolveCaret(math, caret);
  if (!resolved) return failure(caret, "invalid-caret");

  if (resolved.kind === "text") {
    const atomic = atomicCommandDeletion(
      resolved,
      resolved.position,
      resolveCommand,
    );
    if (atomic) return atomic;
    const deleted = resolved.visibleCharacters[resolved.position];
    if (deleted) {
      return success(
        textCaret(
          resolved.row.id,
          resolved.node.id,
          resolved.visibleCharacters[resolved.position - 1]?.id ?? null,
        ),
        [
          {
            kind: "text_delete",
            nodeId: resolved.node.id,
            field: "text",
            charIds: [deleted.id],
          },
        ],
      );
    }
  }

  const gap =
    resolved.kind === "row"
      ? (caret as MathRowCaret)
      : rowCaret(resolved.row.id, resolved.node.id);
  return deleteForwardAtRowGap(math, gap, caret);
}

/** Delete an exact recognized command token as one source-safe unit. */
function atomicCommandDeletion(
  resolved: ResolvedTextCaret,
  characterIndex: number,
  resolveCommand: MathCommandCompletionResolver | undefined,
): MathTreeEditResult | undefined {
  if (!resolveCommand || characterIndex < 0) return undefined;
  const source = resolved.visibleCharacters.map(({ char }) => char).join("");
  const commands = source.matchAll(/\\([A-Za-z]+)/g);
  for (const match of commands) {
    const start = match.index;
    const end = start + match[0].length;
    if (characterIndex < start || characterIndex >= end) continue;
    if (!resolveCommand(match[1], "")) return undefined;
    const characters = resolved.visibleCharacters.slice(start, end);
    return success(
      textCaret(
        resolved.row.id,
        resolved.node.id,
        resolved.visibleCharacters[start - 1]?.id ?? null,
      ),
      [
        {
          kind: "text_delete",
          nodeId: resolved.node.id,
          field: "text",
          charIds: characters.map(({ id }) => id),
        },
      ],
    );
  }
  return undefined;
}

function expandAtomicEndpoint(
  endpoint: ResolvedRangeEndpoint,
  edge: "start" | "end",
  resolveCommand: MathCommandCompletionResolver,
): MathTreeCaret {
  const resolved = endpoint.resolved;
  if (resolved.kind !== "text") return endpoint.caret;
  const source = resolved.visibleCharacters.map(({ char }) => char).join("");
  for (const match of source.matchAll(/\\([A-Za-z]+)/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (
      resolved.position <= start ||
      resolved.position >= end ||
      !resolveCommand(match[1], "")
    ) {
      continue;
    }
    const position = edge === "start" ? start : end;
    return textCaret(
      resolved.row.id,
      resolved.node.id,
      resolved.visibleCharacters[position - 1]?.id ?? null,
    );
  }
  return endpoint.caret;
}

function insertFractionAtGap(
  document: StructuredDocument,
  gap: MathRowCaret,
  identities: IdentityAllocator,
): MathTreeEditResult {
  const placement = placementAtGap(document, gap);
  const row = document.nodes[gap.rowId];
  if (!placement || !row || row.deleted || row.type !== "row") {
    return failure(gap, "invalid-caret");
  }

  const ids = collectDocumentIdentities(document);
  const fractionId = identities.nextId();
  const fractionFailure = acceptNodeIdentity(fractionId, ids);
  if (fractionFailure) return failure(gap, fractionFailure);
  ids.add(fractionId);

  const numeratorId = identities.nextId();
  const numeratorFailure = acceptNodeIdentity(numeratorId, ids);
  if (numeratorFailure) return failure(gap, numeratorFailure);
  ids.add(numeratorId);

  const denominatorId = identities.nextId();
  const denominatorFailure = acceptNodeIdentity(denominatorId, ids);
  if (denominatorFailure) return failure(gap, denominatorFailure);

  const slotOrderKey = generateKeyBetween(null, null);
  const edits: StructuredEdit[] = [
    {
      kind: "node_insert",
      node: {
        id: fractionId,
        type: "fraction",
        placement,
        attrs: {
          bar: "rule",
          style: "auto",
          continued: false,
          leftDelimiterPresent: false,
          rightDelimiterPresent: false,
        },
        textFields: {},
      },
    },
    {
      kind: "node_insert",
      node: {
        id: numeratorId,
        type: "row",
        placement: {
          parentId: fractionId,
          slot: "numerator",
          orderKey: slotOrderKey,
        },
        attrs: {},
        textFields: {},
      },
    },
    {
      kind: "node_insert",
      node: {
        id: denominatorId,
        type: "row",
        placement: {
          parentId: fractionId,
          slot: "denominator",
          orderKey: slotOrderKey,
        },
        attrs: {},
        textFields: {},
      },
    },
  ];
  return success(rowCaret(numeratorId, null), edits);
}

/** Guard a caller-owned allocator against this document's collision domain. */
function guardIdentityAllocator(
  document: StructuredDocument,
  identities: IdentityAllocator,
): {
  readonly identities: IdentityAllocator;
  readonly reason: () => "invalid-identity" | "identity-collision" | undefined;
} {
  const issued = collectDocumentIdentities(document);
  let previousCounter = maxObservedIdentityCounter(issued);
  let allocationFailure: "invalid-identity" | "identity-collision" | undefined;

  return {
    identities: {
      nextId(): string {
        const id = identities.nextId();
        if (issued.has(id)) {
          allocationFailure = "identity-collision";
          throw new Error("Identity allocator collided with math content");
        }
        const counter = allocatedIdentityCounter(id);
        if (counter === null || counter <= previousCounter) {
          allocationFailure = "invalid-identity";
          throw new Error("Identity allocator is stale or malformed");
        }
        issued.add(id);
        previousCounter = counter;
        return id;
      },
    },
    reason: () => allocationFailure,
  };
}

/** Allocate sibling placements without manufacturing a feature id namespace. */
function placementsAtGap(
  document: StructuredDocument,
  gap: MathRowCaret,
  count: number,
):
  | readonly {
      readonly parentId: string;
      readonly slot: "children";
      readonly orderKey: string;
    }[]
  | undefined {
  const resolved = resolveCaret(document, gap);
  if (!resolved || resolved.kind !== "row") return undefined;
  const all = getStructuredChildren(document, gap.rowId, "children", {
    includeDeleted: true,
  });
  const anchorIndex =
    gap.afterNodeId === null
      ? -1
      : all.findIndex((node) => node.id === gap.afterNodeId);
  if (gap.afterNodeId !== null && anchorIndex < 0) return undefined;
  const keys = generateNKeysBetween(
    all[anchorIndex]?.placement.orderKey ?? null,
    all[anchorIndex + 1]?.placement.orderKey ?? null,
    count,
  );
  return keys.map((orderKey) => ({
    parentId: gap.rowId,
    slot: "children" as const,
    orderKey,
  }));
}

function finiteMatrixDimension(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function appendPlacements(
  document: StructuredDocument,
  parentId: string,
  slot: string,
  count: number,
): readonly {
  readonly parentId: string;
  readonly slot: string;
  readonly orderKey: string;
}[] {
  const children = getStructuredChildren(document, parentId, slot, {
    includeDeleted: true,
  });
  const keys = generateNKeysBetween(
    children.at(-1)?.placement.orderKey ?? null,
    null,
    count,
  );
  return keys.map((orderKey) => ({ parentId, slot, orderKey }));
}

function nodeInsertion(
  id: string,
  type: string,
  placement: StructuredNode["placement"],
): StructuredEdit {
  return {
    kind: "node_insert",
    node: { id, type, placement, attrs: {}, textFields: {} },
  };
}

/** Flatten a parsed fragment into parent-before-child generic CRDT inserts. */
function semanticSubtreeInsertions(
  fragment: StructuredDocument,
  roots: readonly StructuredNode[],
  rootPlacements: readonly {
    readonly parentId: string;
    readonly slot: "children";
    readonly orderKey: string;
  }[],
): StructuredEdit[] {
  const edits: StructuredEdit[] = [];
  const nodes = Object.values(fragment.nodes);
  const visit = (node: StructuredNode, placement = node.placement): void => {
    edits.push({
      kind: "node_insert",
      node: {
        id: node.id,
        type: node.type,
        placement,
        attrs: node.attrs,
        textFields: node.textFields,
      },
    });
    const children = nodes
      .filter(
        (candidate) =>
          !candidate.deleted && candidate.placement.parentId === node.id,
      )
      .sort(
        (left, right) =>
          left.placement.slot.localeCompare(right.placement.slot) ||
          left.placement.orderKey.localeCompare(right.placement.orderKey) ||
          left.id.localeCompare(right.id),
      );
    for (const child of children) visit(child);
  };
  roots.forEach((root, index) => visit(root, rootPlacements[index]));
  return edits;
}

/** Pick the menu-style first slot without translating back through offsets. */
function preferredInsertedCaret(
  fragment: StructuredDocument,
  targetRowId: string,
  roots: readonly StructuredNode[],
): MathTreeCaret {
  for (const node of roots) {
    const slot = preferredNodeSlot(fragment, node);
    if (slot) return rowCaret(slot.id, null);
    if (node.type === "raw-text") {
      return textCaret(
        targetRowId,
        node.id,
        visibleCharacters(node).at(-1)?.id ?? null,
      );
    }
  }
  return rowCaret(targetRowId, roots.at(-1)?.id ?? null);
}

function preferredNodeSlot(
  document: StructuredDocument,
  node: StructuredNode,
): StructuredNode | undefined {
  switch (node.type) {
    case "fraction":
      return onlyChild(document, node.id, "numerator", "row");
    case "radical":
      return onlyChild(document, node.id, "radicand", "row");
    case "scripts":
      return (
        onlyChild(document, node.id, "subscript", "row") ??
        onlyChild(document, node.id, "superscript", "row")
      );
    case "delimited":
      return onlyChild(document, node.id, "body", "row");
    case "matrix": {
      const matrixRow = getStructuredChildren(document, node.id, "rows")[0];
      const cell = matrixRow
        ? getStructuredChildren(document, matrixRow.id, "cells")[0]
        : undefined;
      return cell ? onlyChild(document, cell.id, "body", "row") : undefined;
    }
    default:
      return undefined;
  }
}

function backspaceAtRowGap(
  document: StructuredDocument,
  gap: MathRowCaret,
  originalCaret: MathTreeCaret,
): MathTreeEditResult {
  const resolved = resolveCaret(document, gap);
  if (!resolved || resolved.kind !== "row") {
    return failure(originalCaret, "invalid-caret");
  }

  if (isSemanticallyEmptyRow(document, resolved.row.id)) {
    const unwrapped = unwrapFromEmptyFractionSlot(document, resolved.row.id);
    if (unwrapped) return unwrapped;
    const removed = removeEmptyRadical(document, resolved.row.id);
    if (removed) return removed;
  }

  // A visually empty matrix cell has nothing to delete: its topology belongs
  // to the matrix, not the caret. Backspace degrades to arrow-left so the
  // caret walks back through the grid (or out of the matrix from the first
  // cell) instead of silently consuming the key or peeling an invisible
  // placeholder.
  if (isVisuallyEmptyMatrixCellRow(document, resolved.row.id)) {
    const destination = moveLeftFromRowGap(document, gap);
    if (destination) return success(destination, []);
  }

  const children = getStructuredChildren(document, resolved.row.id, "children");
  const previous = children[resolved.position - 1];
  if (!previous) return failure(originalCaret, "no-navigation-target");

  if (previous.type === "raw-text") {
    const characters = visibleCharacters(previous);
    if (characters.length === 0) {
      return success(gapBeforeNode(document, resolved.row.id, previous.id)!, [
        { kind: "node_delete", nodeId: previous.id },
      ]);
    }
    const deleted = characters.at(-1)!;
    const beforeDeleted = characters.at(-2);
    return success(
      textCaret(resolved.row.id, previous.id, beforeDeleted?.id ?? null),
      [
        {
          kind: "text_delete",
          nodeId: previous.id,
          field: "text",
          charIds: [deleted.id],
        },
      ],
    );
  }

  if (previous.type === "fraction") {
    const destination = fractionSlotCaret(
      document,
      previous.id,
      "denominator",
      "end",
    );
    return destination
      ? success(destination, [])
      : failure(originalCaret, "no-navigation-target");
  }

  if (isAtomicMathLeaf(previous)) {
    const before = gapBeforeNode(document, resolved.row.id, previous.id);
    return before
      ? success(before, [{ kind: "node_delete", nodeId: previous.id }])
      : failure(originalCaret, "invalid-caret");
  }

  return failure(originalCaret, "unsupported-position");
}

function deleteForwardAtRowGap(
  document: StructuredDocument,
  gap: MathRowCaret,
  originalCaret: MathTreeCaret,
): MathTreeEditResult {
  const resolved = resolveCaret(document, gap);
  if (!resolved || resolved.kind !== "row") {
    return failure(originalCaret, "invalid-caret");
  }

  // Mirror of the Backspace rule: forward Delete in a visually empty matrix
  // cell degrades to arrow-right instead of claiming a no-op or peeling an
  // invisible placeholder.
  if (isVisuallyEmptyMatrixCellRow(document, resolved.row.id)) {
    const destination = moveRightFromRowGap(document, gap);
    if (destination) return success(destination, []);
  }

  const children = getStructuredChildren(document, resolved.row.id, "children");
  const next = children[resolved.position];
  if (next?.type === "raw-text") {
    const characters = visibleCharacters(next);
    if (characters.length === 0) {
      return success(gap, [{ kind: "node_delete", nodeId: next.id }]);
    }
    return success(originalCaret, [
      {
        kind: "text_delete",
        nodeId: next.id,
        field: "text",
        charIds: [characters[0].id],
      },
    ]);
  }

  if (next?.type === "fraction") {
    const destination = fractionSlotCaret(
      document,
      next.id,
      "numerator",
      "start",
    );
    return destination
      ? success(destination, [])
      : failure(originalCaret, "no-navigation-target");
  }

  if (next && isAtomicMathLeaf(next)) {
    return success(originalCaret, [{ kind: "node_delete", nodeId: next.id }]);
  }

  if (next) return failure(originalCaret, "unsupported-position");

  const slot = fractionSlotForRow(document, resolved.row.id);
  if (!slot) return failure(originalCaret, "no-navigation-target");
  const destination =
    slot.slot === "numerator"
      ? fractionSlotCaret(document, slot.fraction.id, "denominator", "start")
      : caretAfterFraction(document, slot.fraction);
  return destination
    ? success(destination, [])
    : failure(originalCaret, "no-navigation-target");
}

function unwrapFromEmptyFractionSlot(
  document: StructuredDocument,
  rowId: string,
): MathTreeEditResult | undefined {
  const current = fractionSlotForRow(document, rowId);
  if (!current || !isSemanticallyEmptyRow(document, rowId)) return undefined;

  const outerRowId = current.fraction.placement.parentId;
  const outerRow = outerRowId ? document.nodes[outerRowId] : undefined;
  if (
    !outerRow ||
    outerRow.deleted ||
    outerRow.type !== "row" ||
    current.fraction.placement.slot !== "children"
  ) {
    return undefined;
  }

  const preservedSlot =
    current.slot === "numerator" ? "denominator" : "numerator";
  const preservedRow = onlyChild(
    document,
    current.fraction.id,
    preservedSlot,
    "row",
  );
  if (!preservedRow) return undefined;
  const preserved = getStructuredChildren(
    document,
    preservedRow.id,
    "children",
  ).filter((node) => nodeHasSemanticContent(document, node));

  const allOuterChildren = getStructuredChildren(
    document,
    outerRow.id,
    "children",
    { includeDeleted: true },
  );
  const fractionIndex = allOuterChildren.findIndex(
    (node) => node.id === current.fraction.id,
  );
  if (fractionIndex < 0) return undefined;
  const lowerKey =
    allOuterChildren[fractionIndex - 1]?.placement.orderKey ?? null;
  const upperKey =
    allOuterChildren[fractionIndex + 1]?.placement.orderKey ?? null;
  const keys = generateNKeysBetween(lowerKey, upperKey, preserved.length);
  const edits: StructuredEdit[] = preserved.map((node, index) => ({
    kind: "node_move",
    nodeId: node.id,
    placement: {
      parentId: outerRow.id,
      slot: "children",
      orderKey: keys[index],
    },
  }));
  edits.push({ kind: "node_delete", nodeId: current.fraction.id });

  const visibleOuter = getStructuredChildren(document, outerRow.id, "children");
  const visibleFractionIndex = visibleOuter.findIndex(
    (node) => node.id === current.fraction.id,
  );
  const beforeFraction = visibleOuter[visibleFractionIndex - 1]?.id ?? null;
  const afterNodeId =
    current.slot === "denominator" && preserved.length > 0
      ? preserved.at(-1)!.id
      : beforeFraction;
  return success(rowCaret(outerRow.id, afterNodeId), edits);
}

/** Backspace in a wholly empty radical removes the construct, never `\sqrt`. */
function removeEmptyRadical(
  document: StructuredDocument,
  rowId: string,
): MathTreeEditResult | undefined {
  const row = document.nodes[rowId];
  const radicalId = row?.placement.parentId;
  const radical = radicalId ? document.nodes[radicalId] : undefined;
  if (
    !row ||
    row.deleted ||
    row.type !== "row" ||
    row.placement.slot !== "radicand" ||
    !radical ||
    radical.deleted ||
    radical.type !== "radical"
  ) {
    return undefined;
  }
  const indexRows = getStructuredChildren(document, radical.id, "index");
  if (
    indexRows.some(
      (index) =>
        index.type !== "row" || !isSemanticallyEmptyRow(document, index.id),
    )
  ) {
    return undefined;
  }
  const outerRowId = radical.placement.parentId;
  const outerRow = outerRowId ? document.nodes[outerRowId] : undefined;
  if (
    !outerRow ||
    outerRow.deleted ||
    outerRow.type !== "row" ||
    radical.placement.slot !== "children"
  ) {
    return undefined;
  }
  return success(
    rowCaret(outerRow.id, previousSiblingId(document, outerRow.id, radical.id)),
    [{ kind: "node_delete", nodeId: radical.id }],
  );
}

function moveCaretRight(
  document: StructuredDocument,
  caret: MathTreeCaret,
  resolved: ResolvedCaret,
): MathTreeCaret | undefined {
  if (resolved.kind === "text") {
    const next = resolved.visibleCharacters[resolved.position];
    if (next) return textCaret(resolved.row.id, resolved.node.id, next.id);
    return moveRightFromRowGap(
      document,
      rowCaret(resolved.row.id, resolved.node.id),
    );
  }
  return moveRightFromRowGap(document, caret as MathRowCaret);
}

function moveRightFromRowGap(
  document: StructuredDocument,
  gap: MathRowCaret,
): MathTreeCaret | undefined {
  const resolved = resolveCaret(document, gap);
  if (!resolved || resolved.kind !== "row") return undefined;
  const children = getStructuredChildren(document, gap.rowId, "children");
  // When a row consists entirely of empty groups, every group is rendered as
  // its own placeholder box. The gap before the first group already addresses
  // the first box, so advance one boundary at a time instead of skipping the
  // whole run. A single placeholder still exits the row in one press (not two),
  // which keeps empty matrix-cell traversal unchanged.
  if (
    rowHasMultipleVisibleEmptyGroups(document, children) &&
    resolved.position < children.length - 1
  ) {
    return rowCaret(resolved.row.id, children[resolved.position].id);
  }
  let nextIndex = resolved.position;
  while (isEmptyNavigationPlaceholder(document, children[nextIndex])) {
    nextIndex += 1;
  }
  const next = children[nextIndex];
  if (next) return moveIntoNextNode(document, resolved.row.id, next);

  const owner = navigationOwnerForRow(document, resolved.row.id);
  if (!owner) return undefined;
  const rowIndex = owner.rows.findIndex((row) => row.id === resolved.row.id);
  const nextRow = owner.rows[rowIndex + 1];
  return nextRow
    ? enterRow(document, nextRow, "start")
    : caretAfterNode(document, owner.node);
}

function moveCaretLeft(
  document: StructuredDocument,
  caret: MathTreeCaret,
  resolved: ResolvedCaret,
): MathTreeCaret | undefined {
  if (resolved.kind === "text") {
    if (resolved.position > 0) {
      const previous = resolved.visibleCharacters[resolved.position - 2];
      return textCaret(resolved.row.id, resolved.node.id, previous?.id ?? null);
    }
    const gap = gapBeforeNode(document, resolved.row.id, resolved.node.id);
    return gap ? moveLeftFromRowGap(document, gap) : undefined;
  }
  return moveLeftFromRowGap(document, caret as MathRowCaret);
}

function moveLeftFromRowGap(
  document: StructuredDocument,
  gap: MathRowCaret,
): MathTreeCaret | undefined {
  const resolved = resolveCaret(document, gap);
  if (!resolved || resolved.kind !== "row") return undefined;
  const children = getStructuredChildren(document, gap.rowId, "children");
  // Reverse of moveRightFromRowGap's visible empty-group traversal. The gap
  // after the last group addresses the last box when entering from the right.
  if (
    rowHasMultipleVisibleEmptyGroups(document, children) &&
    resolved.position > 1
  ) {
    return rowCaret(resolved.row.id, children[resolved.position - 2].id);
  }
  let previousIndex = resolved.position - 1;
  while (isEmptyNavigationPlaceholder(document, children[previousIndex])) {
    previousIndex -= 1;
  }
  const previous = children[previousIndex];
  if (previous)
    return moveIntoPreviousNode(document, resolved.row.id, previous);

  const owner = navigationOwnerForRow(document, resolved.row.id);
  if (!owner) return undefined;
  const rowIndex = owner.rows.findIndex((row) => row.id === resolved.row.id);
  const previousRow = owner.rows[rowIndex - 1];
  return previousRow
    ? enterRow(document, previousRow, "end")
    : caretBeforeNode(document, owner.node);
}

/**
 * Advance right by one visible stop from the gap before `node`.
 *
 * A raw-text start and the row gap immediately before it share the same painted
 * caret geometry. Returning the text start would therefore consume an arrow
 * press without moving the caret. Enter the first character instead. Atomic
 * nodes similarly move from their leading edge to their trailing edge, while
 * multi-row constructs remain enterable.
 */
function moveIntoNextNode(
  document: StructuredDocument,
  rowId: string,
  node: StructuredNode,
): MathTreeCaret {
  if (node.type === "raw-text") {
    const first = visibleCharacters(node)[0];
    return first
      ? textCaret(rowId, node.id, first.id)
      : rowCaret(rowId, node.id);
  }
  if (navigationRowsForNode(document, node).length > 0) {
    return enterNode(document, rowId, node, "start");
  }
  return rowCaret(rowId, node.id);
}

/** Mirror of {@link moveIntoNextNode} for the gap after `node`. */
function moveIntoPreviousNode(
  document: StructuredDocument,
  rowId: string,
  node: StructuredNode,
): MathTreeCaret {
  if (node.type === "raw-text") {
    const characters = visibleCharacters(node);
    return textCaret(rowId, node.id, characters.at(-2)?.id ?? null);
  }
  if (navigationRowsForNode(document, node).length > 0) {
    return enterNode(document, rowId, node, "end");
  }
  return rowCaret(rowId, previousSiblingId(document, rowId, node.id));
}

interface NavigationOwner {
  readonly node: StructuredNode;
  readonly rows: readonly StructuredNode[];
}

/**
 * Resolve the semantic construct that directly owns an editable row. Matrix
 * rows/cells are transparent containers: Left/Right traverse their cell-body
 * rows in grid order instead of treating the whole matrix as one opaque atom.
 */
function navigationOwnerForRow(
  document: StructuredDocument,
  rowId: string,
): NavigationOwner | undefined {
  const row = document.nodes[rowId];
  let parentId = row?.placement.parentId ?? null;
  while (parentId) {
    const parent = document.nodes[parentId];
    if (!parent || parent.deleted) return undefined;
    const rows = navigationRowsForNode(document, parent);
    if (rows.some((candidate) => candidate.id === rowId)) {
      return { node: parent, rows };
    }
    if (parent.type !== "matrix-cell" && parent.type !== "matrix-row") {
      return undefined;
    }
    parentId = parent.placement.parentId;
  }
  return undefined;
}

/** Direct editable rows in logical keyboard order for one semantic node. */
function navigationRowsForNode(
  document: StructuredDocument,
  node: StructuredNode,
): readonly StructuredNode[] {
  const rows = (slot: string) =>
    getStructuredChildren(document, node.id, slot).filter(
      (candidate) => candidate.type === "row",
    );
  switch (node.type) {
    case "fraction":
      return [...rows("numerator"), ...rows("denominator")];
    case "radical":
      return [...rows("index"), ...rows("radicand")];
    case "scripts":
      return [...rows("base"), ...rows("subscript"), ...rows("superscript")];
    case "delimited":
      return rows("body");
    case "matrix":
      return getStructuredChildren(document, node.id, "rows").flatMap(
        (matrixRow) =>
          getStructuredChildren(document, matrixRow.id, "cells").flatMap(
            (cell) =>
              getStructuredChildren(document, cell.id, "body").filter(
                (candidate) => candidate.type === "row",
              ),
          ),
      );
    default:
      return [];
  }
}

function enterRow(
  document: StructuredDocument,
  row: StructuredNode,
  edge: "start" | "end",
): MathTreeCaret {
  const children = getStructuredChildren(document, row.id, "children");
  const child = edge === "start" ? children[0] : children.at(-1);
  return child
    ? enterNode(document, row.id, child, edge)
    : rowCaret(row.id, null);
}

function enterNode(
  document: StructuredDocument,
  rowId: string,
  node: StructuredNode,
  edge: "start" | "end",
): MathTreeCaret {
  if (node.type === "raw-text") {
    const characters = visibleCharacters(node);
    return textCaret(
      rowId,
      node.id,
      edge === "end" ? (characters.at(-1)?.id ?? null) : null,
    );
  }
  if (node.type === "fraction") {
    return (
      fractionSlotCaret(
        document,
        node.id,
        edge === "start" ? "numerator" : "denominator",
        edge,
      ) ??
      rowCaret(
        rowId,
        edge === "start"
          ? node.id
          : previousSiblingId(document, rowId, node.id),
      )
    );
  }
  const rows = navigationRowsForNode(document, node);
  const row = edge === "start" ? rows[0] : rows.at(-1);
  if (row) return enterRow(document, row, edge);
  return rowCaret(
    rowId,
    edge === "start" ? previousSiblingId(document, rowId, node.id) : node.id,
  );
}

function caretAfterNode(
  document: StructuredDocument,
  node: StructuredNode,
): MathTreeCaret | undefined {
  const rowId = node.placement.parentId;
  const row = rowId ? document.nodes[rowId] : undefined;
  return row && !row.deleted && row.type === "row"
    ? rowCaret(row.id, node.id)
    : undefined;
}

function caretBeforeNode(
  document: StructuredDocument,
  node: StructuredNode,
): MathTreeCaret | undefined {
  const rowId = node.placement.parentId;
  const row = rowId ? document.nodes[rowId] : undefined;
  return row && !row.deleted && row.type === "row"
    ? rowCaret(row.id, previousSiblingId(document, row.id, node.id))
    : undefined;
}

function fractionSlotCaret(
  document: StructuredDocument,
  fractionId: string,
  slot: "numerator" | "denominator",
  edge: "start" | "end",
): MathTreeCaret | undefined {
  const row = onlyChild(document, fractionId, slot, "row");
  if (!row) return undefined;
  if (edge === "start") return rowCaret(row.id, null);
  const children = getStructuredChildren(document, row.id, "children");
  const last = children.at(-1);
  return last
    ? enterNode(document, row.id, last, "end")
    : rowCaret(row.id, null);
}

function caretAfterFraction(
  document: StructuredDocument,
  fraction: StructuredNode,
): MathTreeCaret | undefined {
  const rowId = fraction.placement.parentId;
  const row = rowId ? document.nodes[rowId] : undefined;
  return row && !row.deleted && row.type === "row"
    ? rowCaret(row.id, fraction.id)
    : undefined;
}

function caretBeforeFraction(
  document: StructuredDocument,
  fraction: StructuredNode,
): MathTreeCaret | undefined {
  const rowId = fraction.placement.parentId;
  const row = rowId ? document.nodes[rowId] : undefined;
  return row && !row.deleted && row.type === "row"
    ? rowCaret(row.id, previousSiblingId(document, row.id, fraction.id))
    : undefined;
}

function structuralGapForCaret(
  document: StructuredDocument,
  caret: MathTreeCaret,
  resolved: ResolvedCaret,
): MathRowCaret | undefined {
  if (resolved.kind === "row") return caret as MathRowCaret;
  if (resolved.position === resolved.visibleCharacters.length) {
    return rowCaret(resolved.row.id, resolved.node.id);
  }
  if (resolved.position === 0) {
    return gapBeforeNode(document, resolved.row.id, resolved.node.id);
  }
  return undefined;
}

/** Resolve an edge gap or describe the suffix needed for an interior splice. */
function semanticInsertionSite(
  document: StructuredDocument,
  caret: MathTreeCaret,
  resolved: ResolvedCaret,
): SemanticInsertionSite | undefined {
  const gap = structuralGapForCaret(document, caret, resolved);
  if (gap) return { gap };
  if (resolved.kind !== "text") return undefined;
  if (
    resolved.position <= 0 ||
    resolved.position >= resolved.visibleCharacters.length
  ) {
    return undefined;
  }
  return {
    gap: rowCaret(resolved.row.id, resolved.node.id),
    split: {
      source: resolved.node,
      characters: resolved.visibleCharacters.slice(resolved.position),
    },
  };
}

function resolveCaret(
  document: StructuredDocument,
  caret: MathTreeCaret,
): ResolvedCaret | undefined {
  const row = document.nodes[caret.rowId];
  if (
    !row ||
    row.deleted ||
    row.type !== "row" ||
    !isReachable(document, row.id)
  ) {
    return undefined;
  }

  if (caret.kind === "row") {
    const all = getStructuredChildren(document, row.id, "children", {
      includeDeleted: true,
    });
    if (caret.afterNodeId === null) return { kind: "row", row, position: 0 };
    let visiblePosition = 0;
    for (const node of all) {
      if (!node.deleted) visiblePosition += 1;
      if (node.id === caret.afterNodeId) {
        return { kind: "row", row, position: visiblePosition };
      }
    }
    return undefined;
  }

  const node = document.nodes[caret.nodeId];
  if (
    !node ||
    node.deleted ||
    node.type !== "raw-text" ||
    caret.field !== "text" ||
    node.placement.parentId !== row.id ||
    node.placement.slot !== "children" ||
    !Object.prototype.hasOwnProperty.call(node.textFields, "text")
  ) {
    return undefined;
  }

  const allCharacters = [...iterateAllChars([...node.textFields.text])].map(
    ({ id, char, deleted }) => ({ id, char, deleted }),
  );
  const visible = allCharacters
    .filter((entry) => !entry.deleted)
    .map(({ id, char }) => ({ id, char }));
  if (caret.afterCharId === null) {
    return {
      kind: "text",
      row,
      node,
      allCharacters,
      visibleCharacters: visible,
      position: 0,
    };
  }
  let visiblePosition = 0;
  for (const entry of allCharacters) {
    if (!entry.deleted) visiblePosition += 1;
    if (entry.id === caret.afterCharId) {
      return {
        kind: "text",
        row,
        node,
        allCharacters,
        visibleCharacters: visible,
        position: visiblePosition,
      };
    }
  }
  return undefined;
}

function resolveOrderedRange(
  document: StructuredDocument,
  range: MathTreeRange,
): ResolveRangeResult {
  const anchor = resolveRangeEndpoint(document, range.anchor);
  const focus = resolveRangeEndpoint(document, range.focus);
  if (!anchor || !focus) return { ok: false, reason: "invalid-caret" };
  if (anchor.resolved.row.id !== focus.resolved.row.id) {
    return { ok: false, reason: "unsupported-cross-slot-range" };
  }

  const children = getStructuredChildren(
    document,
    anchor.resolved.row.id,
    "children",
  );
  const [start, end] =
    compareRangeEndpoints(anchor, focus) <= 0
      ? [anchor, focus]
      : [focus, anchor];
  return {
    ok: true,
    range: { row: anchor.resolved.row, children, start, end },
  };
}

function resolveRangeEndpoint(
  document: StructuredDocument,
  caret: MathTreeCaret,
): ResolvedRangeEndpoint | undefined {
  const resolved = resolveCaret(document, caret);
  if (!resolved) return undefined;
  if (resolved.kind === "row") {
    return { caret, resolved, childIndex: resolved.position };
  }
  const children = getStructuredChildren(document, resolved.row.id, "children");
  const childIndex = children.findIndex((node) => node.id === resolved.node.id);
  return childIndex < 0 ? undefined : { caret, resolved, childIndex };
}

function compareRangeEndpoints(
  left: ResolvedRangeEndpoint,
  right: ResolvedRangeEndpoint,
): number {
  const leftRank =
    left.childIndex * 2 + (left.resolved.kind === "text" ? 1 : 0);
  const rightRank =
    right.childIndex * 2 + (right.resolved.kind === "text" ? 1 : 0);
  if (leftRank !== rightRank) return leftRank - rightRank;
  return left.resolved.kind === "text" && right.resolved.kind === "text"
    ? left.resolved.position - right.resolved.position
    : 0;
}

function caretAtRangeStart(range: ResolvedOrderedRange): MathTreeCaret {
  const { resolved } = range.start;
  if (resolved.kind === "text") {
    return textCaret(
      resolved.row.id,
      resolved.node.id,
      resolved.visibleCharacters[resolved.position - 1]?.id ?? null,
    );
  }
  return rowCaret(
    resolved.row.id,
    range.children[resolved.position - 1]?.id ?? null,
  );
}

function editsForOrderedRange(range: ResolvedOrderedRange): StructuredEdit[] {
  const edits: StructuredEdit[] = [];
  for (let index = 0; index < range.children.length; index++) {
    const node = range.children[index];
    if (node.type !== "raw-text") {
      if (isFullySelectedChild(range, index)) {
        edits.push({ kind: "node_delete", nodeId: node.id });
      }
      continue;
    }

    const characters = visibleCharacters(node);
    const fullySelected = isFullySelectedChild(range, index);
    const endpointOwned =
      isTextEndpointNode(range.start, node.id) ||
      isTextEndpointNode(range.end, node.id);
    if (fullySelected && !endpointOwned) {
      edits.push({ kind: "node_delete", nodeId: node.id });
      continue;
    }

    const bounds = selectedTextBounds(range, index, characters.length);
    const charIds = bounds
      ? characters.slice(bounds.start, bounds.end).map((entry) => entry.id)
      : [];
    if (charIds.length > 0) {
      edits.push({
        kind: "text_delete",
        nodeId: node.id,
        field: "text",
        charIds,
      });
    } else if (fullySelected && characters.length === 0 && !endpointOwned) {
      edits.push({ kind: "node_delete", nodeId: node.id });
    }
  }
  return edits;
}

function selectedTextBounds(
  range: ResolvedOrderedRange,
  childIndex: number,
  length: number,
): { readonly start: number; readonly end: number } | undefined {
  let start = 0;
  if (range.start.resolved.kind === "text") {
    if (childIndex < range.start.childIndex) return undefined;
    if (childIndex === range.start.childIndex) {
      start = range.start.resolved.position;
    }
  } else if (childIndex < range.start.childIndex) {
    return undefined;
  }

  let end = length;
  if (range.end.resolved.kind === "text") {
    if (childIndex > range.end.childIndex) return undefined;
    if (childIndex === range.end.childIndex) {
      end = range.end.resolved.position;
    }
  } else if (childIndex >= range.end.childIndex) {
    return undefined;
  }

  return start < end ? { start, end } : undefined;
}

function isFullySelectedChild(
  range: ResolvedOrderedRange,
  childIndex: number,
): boolean {
  const afterStart =
    range.start.resolved.kind === "row"
      ? childIndex >= range.start.childIndex
      : childIndex > range.start.childIndex;
  const beforeEnd = childIndex < range.end.childIndex;
  return afterStart && beforeEnd;
}

function isTextEndpointNode(
  endpoint: ResolvedRangeEndpoint,
  nodeId: string,
): boolean {
  return (
    endpoint.resolved.kind === "text" && endpoint.resolved.node.id === nodeId
  );
}

function placementAtGap(
  document: StructuredDocument,
  gap: MathRowCaret,
):
  | {
      readonly parentId: string;
      readonly slot: string;
      readonly orderKey: string;
    }
  | undefined {
  const resolved = resolveCaret(document, gap);
  if (!resolved || resolved.kind !== "row") return undefined;
  const all = getStructuredChildren(document, gap.rowId, "children", {
    includeDeleted: true,
  });
  const anchorIndex =
    gap.afterNodeId === null
      ? -1
      : all.findIndex((node) => node.id === gap.afterNodeId);
  if (gap.afterNodeId !== null && anchorIndex < 0) return undefined;
  return {
    parentId: gap.rowId,
    slot: "children",
    orderKey: generateKeyBetween(
      all[anchorIndex]?.placement.orderKey ?? null,
      all[anchorIndex + 1]?.placement.orderKey ?? null,
    ),
  };
}

function gapBeforeNode(
  document: StructuredDocument,
  rowId: string,
  nodeId: string,
): MathRowCaret | undefined {
  const all = getStructuredChildren(document, rowId, "children", {
    includeDeleted: true,
  });
  const index = all.findIndex((node) => node.id === nodeId);
  return index < 0 ? undefined : rowCaret(rowId, all[index - 1]?.id ?? null);
}

function previousSiblingId(
  document: StructuredDocument,
  rowId: string,
  nodeId: string,
): string | null {
  const children = getStructuredChildren(document, rowId, "children");
  const index = children.findIndex((node) => node.id === nodeId);
  return index > 0 ? children[index - 1].id : null;
}

function fractionSlotForRow(
  document: StructuredDocument,
  rowId: string,
): FractionSlot | undefined {
  const row = document.nodes[rowId];
  const parentId = row?.placement.parentId;
  const fraction = parentId ? document.nodes[parentId] : undefined;
  const slot = row?.placement.slot;
  return row &&
    !row.deleted &&
    row.type === "row" &&
    fraction &&
    !fraction.deleted &&
    fraction.type === "fraction" &&
    (slot === "numerator" || slot === "denominator")
    ? { fraction, row, slot }
    : undefined;
}

function onlyChild(
  document: StructuredDocument,
  parentId: string,
  slot: string,
  type: string,
): StructuredNode | undefined {
  const children = getStructuredChildren(document, parentId, slot);
  return children.length === 1 && children[0].type === type
    ? children[0]
    : undefined;
}

/** Whether `rowId` is the editable body row of a live matrix cell. */
function isMatrixCellBodyRow(
  document: StructuredDocument,
  rowId: string,
): boolean {
  const row = document.nodes[rowId];
  const cellId = row?.placement.parentId;
  const cell = cellId ? document.nodes[cellId] : undefined;
  return Boolean(
    row &&
    !row.deleted &&
    row.type === "row" &&
    row.placement.slot === "body" &&
    cell &&
    !cell.deleted &&
    cell.type === "matrix-cell",
  );
}

/**
 * Whether one matrix cell body paints as a single empty placeholder box. A
 * truly childless cell, an exhausted raw-text leaf, and the `{}` scaffold the
 * matrix template seeds all render identically, so deletion treats them alike.
 * Multiple `{}` groups are excluded: those are distinct visible boxes.
 */
function isVisuallyEmptyMatrixCellRow(
  document: StructuredDocument,
  rowId: string,
): boolean {
  if (!isMatrixCellBodyRow(document, rowId)) return false;
  const children = getStructuredChildren(document, rowId, "children");
  return (
    !rowHasMultipleVisibleEmptyGroups(document, children) &&
    children.every((child) => isEmptyNavigationPlaceholder(document, child))
  );
}

function isSemanticallyEmptyRow(
  document: StructuredDocument,
  rowId: string,
): boolean {
  return getStructuredChildren(document, rowId, "children").every(
    (node) => !nodeHasSemanticContent(document, node),
  );
}

function nodeHasSemanticContent(
  document: StructuredDocument,
  node: StructuredNode,
): boolean {
  return (
    node.type !== "raw-text" ||
    getStructuredText(document, node.id, "text").length > 0
  );
}

/** Invisible editing scaffolds must not create duplicate painted caret stops. */
function isEmptyNavigationPlaceholder(
  document: StructuredDocument,
  node: StructuredNode | undefined,
): boolean {
  if (!node) return false;
  if (node.type === "raw-text") return visibleCharacters(node).length === 0;
  return (
    node.type === "raw-latex" &&
    getStructuredText(document, node.id, "latex") === "{}"
  );
}

/** Multiple empty groups are multiple painted boxes, not one scaffold run. */
function rowHasMultipleVisibleEmptyGroups(
  document: StructuredDocument,
  children: readonly StructuredNode[],
): boolean {
  return (
    children.length > 1 &&
    children.every(
      (child) =>
        child.type === "raw-latex" &&
        getStructuredText(document, child.id, "latex") === "{}",
    )
  );
}

/** Fields not owned by this controller are deleted only as whole leaves. */
function isAtomicMathLeaf(node: StructuredNode): boolean {
  return (
    node.type === "raw-latex" ||
    node.type === "symbol" ||
    node.type === "operator" ||
    node.type === "text"
  );
}

function isCompositeMathConstruct(node: StructuredNode): boolean {
  return (
    node.type === "fraction" ||
    node.type === "radical" ||
    node.type === "scripts" ||
    node.type === "delimited" ||
    node.type === "matrix"
  );
}

function visibleCharacters(node: StructuredNode): VisibleCharacter[] {
  return [...iterateAllChars([...(node.textFields.text ?? [])])]
    .filter((entry) => !entry.deleted)
    .map(({ id, char }) => ({ id, char }));
}

function validMathDocument(
  document: StructuredDocument,
): StructuredDocument | undefined {
  return document.kind === MATH_STRUCTURED_KIND
    ? validateStructuredMathDocument(document)
    : undefined;
}

function isReachable(document: StructuredDocument, nodeId: string): boolean {
  const seen = new Set<string>();
  let current: string | null = nodeId;
  while (current !== null) {
    if (seen.has(current)) return false;
    seen.add(current);
    const node: StructuredNode | undefined = document.nodes[current];
    if (!node || node.deleted) return false;
    if (current === document.rootId) return node.placement.parentId === null;
    current = node.placement.parentId;
  }
  return false;
}

function collectDocumentIdentities(document: StructuredDocument): Set<string> {
  const ids = new Set(Object.keys(document.nodes));
  for (const node of Object.values(document.nodes)) {
    for (const runs of Object.values(node.textFields)) {
      for (const { id } of iterateAllChars([...runs])) ids.add(id);
    }
  }
  return ids;
}

function acceptNodeIdentity(
  id: string,
  existing: ReadonlySet<string>,
): MathTreeEditFailure | undefined {
  if (existing.has(id)) return "identity-collision";
  const counter = allocatedIdentityCounter(id);
  return counter === null || counter <= maxObservedIdentityCounter(existing)
    ? "invalid-identity"
    : undefined;
}

function mintCharacters(
  text: string,
  identities: IdentityAllocator,
  existing: Set<string>,
):
  | { readonly ok: true; readonly chars: Char[] }
  | {
      readonly ok: false;
      readonly reason: "invalid-identity" | "identity-collision";
    } {
  const chars: Char[] = [];
  let previousCounter = maxObservedIdentityCounter(existing);
  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset];
    const id = identities.nextId();
    if (existing.has(id)) {
      return { ok: false, reason: "identity-collision" };
    }
    const counter = allocatedIdentityCounter(id);
    if (counter === null || counter <= previousCounter) {
      return { ok: false, reason: "invalid-identity" };
    }
    previousCounter = counter;
    existing.add(id);
    chars.push({ id, char });
  }
  return { ok: true, chars };
}

function allocatedIdentityCounter(id: string): number | null {
  return parseAllocatedIdentity(id)?.counter ?? null;
}

function maxObservedIdentityCounter(ids: ReadonlySet<string>): number {
  let max = -1;
  for (const id of ids) {
    const allocated = allocatedIdentityCounter(id);
    const embedded = allocated ?? extractCounter(id);
    if (Number.isSafeInteger(embedded) && embedded >= 0 && embedded > max) {
      max = embedded;
    }
  }
  return max;
}

function rowCaret(rowId: string, afterNodeId: string | null): MathRowCaret {
  return { kind: "row", rowId, afterNodeId };
}

function textCaret(
  rowId: string,
  nodeId: string,
  afterCharId: string | null,
): MathTextCaret {
  return { kind: "text", rowId, nodeId, field: "text", afterCharId };
}

function success(
  caret: MathTreeCaret,
  edits: readonly StructuredEdit[],
): MathTreeEditResult {
  return { handled: true, edits, caret };
}

function failure(
  caret: MathTreeCaret,
  reason: MathTreeEditFailure,
): MathTreeEditResult {
  return { handled: false, edits: [], caret, reason };
}
