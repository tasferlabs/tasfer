/**
 * DevEditorState — the DevToolbar "Editor" tab.
 *
 * Live, read-only inspector for the active editor's internal state: the
 * document's blocks and their CRDT char runs, the caret/selection, active
 * marks, interaction mode, and transient UI state. Rendered by
 * {@link DevToolbar}, so it shows only while developer tools are enabled
 * (Settings → Developer tools; see `@/lib/devTools`).
 *
 * It reads the full internal `EditorState` via the engine's `subscribeRaw`
 * firehose — the documented first-party escape hatch for state the public
 * snapshot doesn't model (per-char runs, `ui.activeMenu`, …). The active editor
 * handle arrives through {@link useActiveEditor}; the editor page registers it.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ChevronDown, Pause, Play } from "lucide-react";
import type { Block } from "@cypherkit/editor";
import {
  getVisibleTextFromRuns,
  isTextualBlock,
  type CharRun,
  type EditorWiring,
  type MarkSpan,
  type TextualBlock,
} from "@cypherkit/editor/internal";
import { useActiveEditor } from "../contexts/ActiveEditorContext";

// ─── View model ──────────────────────────────────────────────────────────────
// A plain, serializable projection of the raw EditorState, recomputed on each
// (coalesced) state tick. Decoupling the render from the live engine object
// keeps the tree printable (Copy JSON) and free of canvas/layout cycles.

interface CharRunView {
  readonly peerId: string;
  readonly startCounter: number;
  readonly text: string;
  readonly deletedMask?: number[];
  /** Count of chars flagged deleted by `deletedMask`. */
  readonly deletedCount: number;
}

interface BlockView {
  readonly index: number;
  readonly id: string;
  readonly type: string;
  readonly deleted: boolean;
  readonly orderKey?: string;
  /** Non-text attrs (charRuns/formats/cachedLayout stripped). */
  readonly attrs: Record<string, unknown>;
  /** Present for textual blocks only. */
  readonly text?: string;
  readonly charRuns?: CharRunView[];
  readonly formats?: MarkSpan[];
  /** Visible (non-deleted) character count, for textual blocks. */
  readonly visibleLength?: number;
}

interface EditorStateView {
  readonly peerId: string;
  readonly mode: string;
  readonly isFocused: boolean;
  readonly caretScratchActive: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly cursor: { blockIndex: number; textIndex: number } | null;
  readonly selection: {
    anchor: { blockIndex: number; textIndex: number };
    focus: { blockIndex: number; textIndex: number };
    isForward: boolean;
    isCollapsed: boolean;
  } | null;
  readonly activeMenu: string;
  readonly composition: unknown;
  readonly activeMarksMode: string;
  readonly caretScratch: unknown;
  readonly decorationLayers: string[];
  readonly visibleBlockCount: number;
  readonly blocks: BlockView[];
}

/** Number of set bits across a `deletedMask` array (each entry is a 32-bit chunk). */
function countDeleted(mask: number[] | undefined): number {
  if (!mask) return 0;
  let total = 0;
  for (let chunk of mask) {
    chunk = chunk - ((chunk >> 1) & 0x55555555);
    chunk = (chunk & 0x33333333) + ((chunk >> 2) & 0x33333333);
    total += (((chunk + (chunk >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
  }
  return total;
}

const STRIPPED_BLOCK_KEYS = new Set([
  "id",
  "type",
  "deleted",
  "orderKey",
  "charRuns",
  "formats",
  "cachedLayout",
  // Neighbour-type render hints — noise for a state view.
  "prevType",
  "nextType",
]);

function blockAttrs(block: Record<string, unknown>): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const key of Object.keys(block)) {
    if (!STRIPPED_BLOCK_KEYS.has(key)) attrs[key] = block[key];
  }
  return attrs;
}

function charRunViews(runs: CharRun[]): CharRunView[] {
  return runs.map((run) => ({
    peerId: run.peerId,
    startCounter: run.startCounter,
    text: run.text,
    deletedMask: run.deletedMask,
    deletedCount: countDeleted(run.deletedMask),
  }));
}

/**
 * Project the raw EditorState into the serializable {@link EditorStateView}.
 * Typed against the structural shape we read so the file needs no internal
 * EditorState import; the runtime object is the engine's real state.
 */
function projectState(state: RawEditorState): EditorStateView {
  const { document, ui, view } = state;
  const cursor = document.cursor
    ? {
        blockIndex: document.cursor.position.blockIndex,
        textIndex: document.cursor.position.textIndex,
      }
    : null;
  const selection = document.selection
    ? {
        anchor: {
          blockIndex: document.selection.anchor.blockIndex,
          textIndex: document.selection.anchor.textIndex,
        },
        focus: {
          blockIndex: document.selection.focus.blockIndex,
          textIndex: document.selection.focus.textIndex,
        },
        isForward: document.selection.isForward,
        isCollapsed: document.selection.isCollapsed,
      }
    : null;

  const blocks: BlockView[] = document.page.blocks.map((block, index) => {
    const base: BlockView = {
      index,
      id: block.id,
      type: block.type,
      deleted: Boolean(block.deleted),
      orderKey: block.orderKey,
      attrs: blockAttrs(block as unknown as Record<string, unknown>),
    };
    if (isTextualBlock(block)) {
      const runs = (block as TextualBlock).charRuns ?? [];
      const text = getVisibleTextFromRuns(runs);
      return {
        ...base,
        text,
        charRuns: charRunViews(runs),
        formats: (block as TextualBlock).formats ?? [],
        visibleLength: text.length,
      };
    }
    return base;
  });

  return {
    peerId: state.CRDTbinding.getPeerId(),
    mode: ui.mode,
    isFocused: view.isFocused,
    caretScratchActive: ui.caretScratch != null,
    undoDepth: state.undoManager.undoStack.length,
    redoDepth: state.undoManager.redoStack.length,
    cursor,
    selection,
    activeMenu: ui.activeMenu?.type ?? "none",
    composition: ui.composition,
    activeMarksMode: ui.activeMarksMode?.type ?? "inherit",
    caretScratch: ui.caretScratch,
    decorationLayers: Object.keys(ui.decorations ?? {}),
    visibleBlockCount: view.visibleBlocks?.length ?? 0,
    blocks,
  };
}

// Minimal structural type for the bits of the raw EditorState we read. Avoids
// importing the engine-internal EditorState type while staying type-checked.
interface RawPosition {
  blockIndex: number;
  textIndex: number;
}
interface RawEditorState {
  document: {
    page: { blocks: Block[] };
    cursor: { position: RawPosition } | null;
    selection: {
      anchor: RawPosition;
      focus: RawPosition;
      isForward: boolean;
      isCollapsed: boolean;
    } | null;
  };
  ui: {
    mode: string;
    activeMenu?: { type: string };
    caretScratch: unknown;
    composition: unknown;
    activeMarksMode?: { type: string };
    decorations?: Record<string, unknown>;
  };
  view: { isFocused: boolean; visibleBlocks?: unknown[] };
  undoManager: { undoStack: unknown[]; redoStack: unknown[] };
  CRDTbinding: { getPeerId(): string };
}

// ─── UI ──────────────────────────────────────────────────────────────────────

function KeyVal({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted-foreground/60 shrink-0">{label}</span>
      <span className="text-foreground tabular-nums truncate">{value}</span>
    </div>
  );
}

function posLabel(p: { blockIndex: number; textIndex: number } | null): string {
  return p ? `b${p.blockIndex}:${p.textIndex}` : "—";
}

function BlockRow({ block }: { block: BlockView }) {
  const [expanded, setExpanded] = useState(false);
  const isText = block.charRuns !== undefined;
  return (
    <div className="border-b border-border/20">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex items-baseline gap-2 px-2.5 py-0.5 hover:bg-muted/20 transition-colors w-full text-start",
          block.deleted && "opacity-40 line-through",
        )}
      >
        <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0 w-6 text-end">
          {block.index}
        </span>
        <span className="text-[10px] font-semibold shrink-0 w-24 truncate text-sky-500">
          {block.type}
        </span>
        <span
          className="text-[10px] text-muted-foreground shrink-0 w-16 truncate"
          title={block.id}
        >
          {block.id.slice(0, 10)}
        </span>
        <span className="text-muted-foreground truncate min-w-0 flex-1">
          {isText
            ? JSON.stringify(block.text)
            : Object.keys(block.attrs).length > 0
              ? JSON.stringify(block.attrs)
              : ""}
        </span>
        {isText && (
          <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">
            {block.charRuns!.length}r · {block.visibleLength}c
          </span>
        )}
        <ChevronDown
          className={cn(
            "w-3 h-3 text-muted-foreground/30 shrink-0 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div className="px-4 py-2 bg-muted/30 flex flex-col gap-2 text-[10px]">
          {block.orderKey && (
            <div className="text-muted-foreground">
              orderKey: <span className="text-foreground">{block.orderKey}</span>
            </div>
          )}
          {Object.keys(block.attrs).length > 0 && (
            <div>
              <div className="text-muted-foreground/60 mb-0.5">attrs</div>
              <pre className="text-muted-foreground whitespace-pre-wrap break-all">
                {JSON.stringify(block.attrs, null, 2)}
              </pre>
            </div>
          )}
          {block.charRuns && block.charRuns.length > 0 && (
            <div>
              <div className="text-muted-foreground/60 mb-0.5">
                charRuns ({block.charRuns.length})
              </div>
              <div className="flex flex-col gap-px font-mono">
                <div className="flex gap-2 text-muted-foreground/50">
                  <span className="w-16 shrink-0">peer</span>
                  <span className="w-12 shrink-0 text-end">start</span>
                  <span className="w-10 shrink-0 text-end">del</span>
                  <span className="min-w-0 flex-1">text</span>
                </div>
                {block.charRuns.map((run, i) => (
                  <div key={i} className="flex gap-2">
                    <span
                      className="w-16 shrink-0 truncate text-muted-foreground"
                      title={run.peerId}
                    >
                      {run.peerId.slice(0, 8)}
                    </span>
                    <span className="w-12 shrink-0 text-end tabular-nums text-muted-foreground">
                      {run.startCounter}
                    </span>
                    <span
                      className={cn(
                        "w-10 shrink-0 text-end tabular-nums",
                        run.deletedCount > 0
                          ? "text-red-500"
                          : "text-muted-foreground/40",
                      )}
                    >
                      {run.deletedCount}
                    </span>
                    <span className="min-w-0 flex-1 break-all text-foreground">
                      {JSON.stringify(run.text)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {block.formats && block.formats.length > 0 && (
            <div>
              <div className="text-muted-foreground/60 mb-0.5">
                formats ({block.formats.length})
              </div>
              <pre className="text-muted-foreground whitespace-pre-wrap break-all">
                {JSON.stringify(block.formats, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DevEditorState() {
  const { editor } = useActiveEditor();
  const [view, setView] = useState<EditorStateView | null>(null);
  const [paused, setPaused] = useState(false);
  // Latest raw state, kept current even while paused so a manual resume/refresh
  // shows the present state rather than the frozen one.
  const latestRef = useRef<RawEditorState | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!editor) {
      setView(null);
      return;
    }
    // `subscribeRaw` lives on the internal EditorWiring surface, not the public
    // EditorApi handle the host holds; the runtime object implements both.
    const wiring = editor as unknown as EditorWiring;

    const flush = () => {
      rafRef.current = null;
      if (pausedRef.current || !latestRef.current) return;
      setView(projectState(latestRef.current));
    };
    const schedule = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(flush);
    };

    const off = wiring.subscribeRaw((state) => {
      latestRef.current = state as unknown as RawEditorState;
      if (!pausedRef.current) schedule();
    });

    return () => {
      off();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [editor]);

  const copy = useCallback(() => {
    if (view) void navigator.clipboard.writeText(JSON.stringify(view, null, 2));
  }, [view]);

  const refresh = useCallback(() => {
    if (latestRef.current) setView(projectState(latestRef.current));
  }, []);

  const summary = useMemo(() => {
    if (!view) return null;
    const textBlocks = view.blocks.filter((b) => b.charRuns !== undefined);
    const chars = textBlocks.reduce((n, b) => n + (b.visibleLength ?? 0), 0);
    const deleted = view.blocks.filter((b) => b.deleted).length;
    return { blocks: view.blocks.length, deleted, chars };
  }, [view]);

  if (!editor || !view) {
    return (
      <div className="flex flex-col flex-1 min-h-0 items-center justify-center text-muted-foreground/50 text-xs">
        No active editor — open a page to inspect its state.
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center h-8 px-2 border-b border-border shrink-0 gap-1.5 text-[10px]">
        <button
          onClick={() => setPaused((v) => !v)}
          className={cn(
            "flex items-center gap-1 h-5 px-1.5 rounded transition-colors shrink-0 border border-border/70",
            paused
              ? "bg-amber-500/20 text-amber-600"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
          title={paused ? "Resume live updates" : "Pause live updates"}
        >
          {paused ? <Play className="w-2.5 h-2.5" /> : <Pause className="w-2.5 h-2.5" />}
          <span>{paused ? "Paused" : "Live"}</span>
        </button>
        <div className="w-px h-3.5 bg-border shrink-0" />
        <span
          className="text-muted-foreground truncate"
          title={`peer ${view.peerId}`}
        >
          {view.peerId.slice(0, 8)}
        </span>
        <span className="text-muted-foreground/60">·</span>
        <span className="text-foreground">{view.mode}</span>
        {view.isFocused && <span className="text-emerald-500">focused</span>}
        <div className="flex-1" />
        {summary && (
          <span className="text-muted-foreground/60 tabular-nums">
            {summary.blocks} blocks · {summary.chars} chars
            {summary.deleted > 0 && ` · ${summary.deleted} del`}
          </span>
        )}
        {paused && (
          <button
            onClick={refresh}
            className="h-5 px-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            Refresh
          </button>
        )}
        <button
          onClick={copy}
          className="h-5 px-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          Copy
        </button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {/* State summary */}
        <div className="px-2.5 py-2 border-b border-border/30 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] font-mono">
          <KeyVal label="cursor" value={posLabel(view.cursor)} />
          <KeyVal
            label="selection"
            value={
              view.selection
                ? `${posLabel(view.selection.anchor)} → ${posLabel(
                    view.selection.focus,
                  )}${view.selection.isCollapsed ? " (collapsed)" : ""}`
                : "—"
            }
          />
          <KeyVal
            label="undo/redo"
            value={`${view.undoDepth} / ${view.redoDepth}`}
          />
          <KeyVal label="activeMenu" value={view.activeMenu} />
          <KeyVal label="marksMode" value={view.activeMarksMode} />
          <KeyVal
            label="composition"
            value={view.composition ? "active" : "—"}
          />
          <KeyVal
            label="caretScratch"
            value={view.caretScratchActive ? "active" : "—"}
          />
          <KeyVal label="visible" value={`${view.visibleBlockCount} blocks`} />
          {view.decorationLayers.length > 0 && (
            <KeyVal
              label="decorations"
              value={view.decorationLayers.join(", ")}
            />
          )}
        </div>

        {/* Blocks */}
        <div className="font-mono text-[11px]">
          {view.blocks.map((block) => (
            <BlockRow key={block.id} block={block} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
