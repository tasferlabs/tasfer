/**
 * @cypherkit/editor/internal — UNSTABLE internal surface.
 *
 * Everything re-exported here is engine machinery or host-only plumbing that a
 * first-party host (e.g. `apps/web`'s `platform/` layer and document tooling)
 * needs, but which is **NOT a public contract**. It carries no semver guarantee
 * — symbols may be renamed, reshaped, or removed in any release. External
 * consumers should depend only on the package root (`@cypherkit/editor`).
 *
 * This entry exists so the package can drop the `./*` wildcard from its
 * `exports` map (which made every source file a frozen public entry point)
 * without breaking the host. New entries here are a smell — prefer promoting a
 * stable, curated API to the root over widening this surface.
 */

// ── Concrete editor class ────────────────────────────────────────────────────
// Hosts hold the spread `CypherEditor` handle (root); the concrete class is
// here for advanced `new Editor(...)` construction. The public action/lifecycle
// type is the interface-shaped `Editor` (= `EditorApi`) at the root.
//
// `EditorWiring` is the doc↔editor wiring channel (`updatePageFromSync` /
// `setBroadcast`) the concrete class also implements — engine-internal plumbing
// `mountEditor` drives, kept off the public `EditorApi` contract.
export type { EditorWiring } from "./entries/editor";
export { Editor as EditorClass } from "./entries/editor";

// ── Low-level CRDT op-log engine ─────────────────────────────────────────────
// The high-level `Doc` (root) sits on top of these. Reach for them only for
// headless CRDT tooling and the convergence fuzz tests.
export type { CRDTbinding } from "./state-types";
export type { SyncEngine } from "./sync/sync";
export {
  createCRDTbinding,
  createSyncEngine,
  maxOpIdCounter,
  maxPageIdCounter,
} from "./sync/sync";

// RGA char-run internals + block ordering (the op-log's lower plumbing).
export type { Char, CharRun, MarkSpan } from "./serlization/loadPage";
export { resolveBlockOrder } from "./sync/crdt-utils";

// ── Host-overlay state-types ─────────────────────────────────────────────────
// Ephemeral view/overlay shapes a host reads when rendering its own chrome.
export type {
  CursorDragState,
  DeepPartial,
  EditorStrings,
  NodeOverlay,
  NodeStringsMap,
  OverlayRect,
  PlaceholderStyles,
  TextStyle,
  ViewportState,
} from "./state-types";

// ── Host-convenience helpers ─────────────────────────────────────────────────
// Read block/format/selection state without a richer `Editor`/`Doc` handle.
// Candidates for future encapsulation behind such a handle.
export { getFormatsAtPosition, getSelectionRange } from "./actions/actions";
export type { TextualBlock } from "./nodes/TextNode";
export { getLinkAtPosition } from "./rendering/marks/LinkMark";
export {
  getBlockTextContent,
  getBlockTextLength,
  isTouchDevice,
} from "./state-utils";
export { isTextualBlock } from "./sync/block-registry";
export {
  extractTitleFromBlocks,
  getVisibleTextFromRuns,
} from "./sync/char-runs";
export { allCharsHaveFormat } from "./sync/crdt-utils";

// Shared image cache (content-addressed bitmaps) + failed-load reset.
export { clearFailedImageCache, imageCache } from "./rendering/renderer";

// Touch cursor-magnifier geometry — for a host rendering its own magnifier.
export {
  MAGNIFIER_HEIGHT,
  MAGNIFIER_MIN_OFFSET_Y,
  MAGNIFIER_POINTER_SIZE,
  MAGNIFIER_WIDTH,
} from "./constants";

// Full `\`-command catalog behind a host's math autocomplete (the curated
// `filterMathCommands`/`MathCommand` live at the root).
export { MATH_COMMANDS } from "./nodes/math-commands";

// Inline-math caret/geometry bridge — for a host rendering its own magnified
// WYSIWYG editor for the chip the caret is inside (see `InlineMathOverlay` in
// apps/web). `getInlineMathCaretRect` places the caret, `getInlineMathOffsetAtX`
// maps a click back to a source offset, and `mathPendingCommandRange` reports a
// half-typed `\command` run to keep it literal — the same three the on-canvas
// chip painter (`MathMark`) uses, exposed so the overlay stays pixel-consistent.
export {
  getInlineMathCaretRect,
  getInlineMathOffsetAtX,
  type InlineMathCaretRect,
  mathPendingCommandRange,
} from "./nodes/math";

// Font internals not part of the curated font surface (`notifyFonts*` are root).
export { currentFontFamily, onFontsReady } from "./fonts";

// Resolve the active theme into concrete render styles — for a host drawing its
// own canvas chrome that must match the editor (e.g. the inline-math overlay's
// caret color comes from `styles.cursor.color`, same as the on-canvas caret).
export { getEditorStyles } from "./styles";

// ── Optional code-block node ─────────────────────────────────────────────────
// `CodeNode` is an opt-in node a host registers in its schema; the highlight
// catalog drives its language UI. Lives here until promoted to a stable node API.
export {
  CODE_LANGUAGES,
  codeLanguageLabel,
  type CodeLanguageOption,
} from "./nodes/code-highlight";
export { CodeNode } from "./nodes/CodeNode";
