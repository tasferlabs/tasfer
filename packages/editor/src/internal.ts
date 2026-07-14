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

// Host clipboard transport for `EditorWiring.setClipboard` — lets native shells
// route copy/cut/paste through their platform clipboard bridge instead of the
// activation-gated `navigator.clipboard`.
export type {
  ClipboardPayload,
  ClipboardReadResult,
  HostClipboard,
} from "./actions/clipboard";

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
export { orderKeyAfter, sortBlocksByOrder } from "./sync/crdt-utils";

// ── Host-overlay state-types ─────────────────────────────────────────────────
// Ephemeral view/overlay shapes a host reads when rendering its own chrome.
export type {
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
  isAndroid,
  isTouchDevice,
} from "./state-utils";
export { canHaveFormats, isTextualBlock } from "./sync/block-registry";
export {
  extractTitleFromBlocks,
  findTitleBlock,
  getVisibleTextFromRuns,
} from "./sync/char-runs";
// The title's rich sibling (markdown of the same title block) plus the
// inline-HTML renderer that turns it into DOM for a cheap host-side title
// preview (marks via their codecs, math via an injected SVG renderer).
export {
  extractTitleMarkdownFromBlocks,
  inlineToHtml,
} from "./serlization/codecs/inline";
export { allCharsHaveFormat } from "./sync/crdt-utils";
// Strips the transient render cache (`cachedLayout`) and neighbour-type stamps a
// mounted editor writes onto the doc's canonical block objects. A host MUST run
// it on `doc.getRawBlocks()` before persisting them or handing them across a
// structured-clone boundary (a worker/`postMessage`): `cachedLayout.lines` hold
// references to live `Mark` instances (with their non-cloneable codec functions)
// and per-canvas measurements that are invalid across sessions/screen sizes.
export { cleanSnapshotForSave } from "./sync/reducer";

// Shared image cache (content-addressed bitmaps) + failed-load reset.
export { clearFailedImageCache, imageCache } from "./rendering/renderer";

// Cover-image geometry: the drawn height (= document-space bottom edge) of a
// first full-width image, which bleeds to the very top of the canvas. The host
// positions page chrome (its tag row) directly below the cover with it.
export { imageBleedHeight } from "./nodes/ImageNode";

// Font internals not part of the curated font surface (`notifyFonts*` are root).
// `getFontMetrics` lets a host lay out chrome around the same line boxes the
// engine renders (e.g. vertically centering a compact single-line editor).
export { currentFontFamily, getFontMetrics, onFontsReady } from "./fonts";

// Resolve the active theme into concrete render styles — for a host drawing its
// own canvas chrome that must match the editor (e.g. reading `styles.cursor.color`
// for a cursor it paints itself, the same color the on-canvas caret uses).
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
