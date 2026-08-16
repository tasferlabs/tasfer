import { Button } from "@/components/ui/button";
import type { Block } from "@tasfer/editor";
import { diffPageWithSnapshot } from "@tasfer/editor/sync/snapshot-diff";
import {
  ChevronLeft,
  FileText,
  GitFork,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppMountedEditor } from "@/editorSchema";
import { MountedEditor } from "../MountedEditor";
import type { IVersion } from "../api/pages.api";
import { versionLabel } from "./versionLabel";

/**
 * Translucent fills marking what this version changed. Same convention as the
 * find highlight: a themeable custom property with a hardcoded fallback, drawn
 * at low opacity so it tints the block rather than replacing its background.
 */
const DIFF_ADDED_FALLBACK = "#22c55e";
const DIFF_CHANGED_FALLBACK = "#eab308";
const DIFF_OPACITY = 0.16;
const DIFF_LAYER = "version-diff";

/** Where the first change is parked below the top edge when the preview opens. */
const DIFF_SCROLL_TOP_MARGIN = 96;

function readRootCssVar(name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

interface SnapshotPreviewProps {
  version: IVersion;
  /** Content at this version. Null while it is still being built. */
  blocks: Block[] | null;
  /** Content at the version before it, for the diff. Null when unavailable. */
  previousBlocks: Block[] | null;
  isLoading?: boolean;
  onBack: () => void;
  onRestore: () => void;
  onFork: () => void;
  isForking?: boolean;
  /**
   * When true, restoring in place is not a valid recovery (e.g. the page is
   * corrupted, so its op-log deterministically rebuilds to the same broken
   * state). Only Fork — which starts a clean page from these blocks — is
   * offered.
   */
  forkOnly?: boolean;
}

export function SnapshotPreview({
  version,
  blocks,
  previousBlocks,
  isLoading,
  onBack,
  onRestore,
  onFork,
  isForking,
  forkOnly,
}: SnapshotPreviewProps) {
  const { t } = useTranslation();
  const [editor, setEditor] = useState<AppMountedEditor["editor"] | null>(null);

  // What this version did to the one before it. Blocks it removed cannot be
  // painted — they are not in the content being shown — so they are reported as
  // a count in the header instead of being faked back into the document.
  const diff = useMemo(() => {
    if (!blocks || !previousBlocks) return null;
    return diffPageWithSnapshot(blocks, previousBlocks);
  }, [blocks, previousBlocks]);

  const touched = useMemo(
    () =>
      diff?.blocks.filter((b) => b.type === "added" || b.type === "modified") ??
      [],
    [diff],
  );

  useEffect(() => {
    if (!editor) return;
    if (!diff) {
      editor.view.clearDecorations(DIFF_LAYER);
      return;
    }
    const added = readRootCssVar("--editor-diff-added", DIFF_ADDED_FALLBACK);
    const changed = readRootCssVar(
      "--editor-diff-changed",
      DIFF_CHANGED_FALLBACK,
    );
    editor.view.setDecorations(
      DIFF_LAYER,
      touched.map((b) => ({
        kind: "block" as const,
        block: b.blockId,
        color: b.type === "added" ? added : changed,
        opacity: DIFF_OPACITY,
      })),
    );
  }, [editor, diff, touched]);

  // Topmost block this version touched, in document order — `diff.blocks` is
  // keyed by id, so the content itself decides which change comes first.
  const firstChangedBlockId = useMemo(() => {
    if (!blocks || touched.length === 0) return null;
    const ids = new Set(touched.map((b) => b.blockId));
    return blocks.find((b) => !b.deleted && ids.has(b.id))?.id ?? null;
  }, [blocks, touched]);

  // Open on the change instead of at the top: a version that edited the tail of
  // a long page otherwise shows a screenful of content it never touched. Guarded
  // per editor instance (one per version — see the `preview-` pageId below) so a
  // later re-render never yanks the reader back to the first change.
  const scrolledIn = useRef<AppMountedEditor["editor"] | null>(null);
  useEffect(() => {
    if (!editor || !firstChangedBlockId) return;
    if (scrolledIn.current === editor) return;
    // The version's own editor is the only one holding this block; a handle left
    // over from the previous selection must not be scrolled and marked done.
    if (!editor.query.block({ block: firstChangedBlockId })) return;
    editor.view.scrollToPosition(
      { block: firstChangedBlockId, offset: 0 },
      { viewportOffsetY: DIFF_SCROLL_TOP_MARGIN },
    );
    scrolledIn.current = editor;
  }, [editor, firstChangedBlockId]);

  const blockCount = blocks?.filter((b) => !b.deleted).length ?? 0;

  return (
    <div className="flex flex-col h-full flex-1">
      {/* Header: back + what this version changed */}
      <div className="flex items-center gap-2 p-3 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="shrink-0"
          aria-label={t("common.back", "Back")}
        >
          <ChevronLeft className="h-5 w-5 rtl:-scale-x-100" />
        </Button>

        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium truncate">
            {versionLabel(version, t)}
          </h3>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3 shrink-0" />
              {t("blocks.blocksCount", {
                count: blockCount,
                defaultValue_one: "{{count, number}} block",
                defaultValue_other: "{{count, number}} blocks",
              })}
            </span>
            {diff && diff.stats.added > 0 && (
              <span className="flex items-center gap-1">
                <Plus className="h-3 w-3 shrink-0" />
                {t("version.diffAdded", {
                  count: diff.stats.added,
                  defaultValue_one: "{{count, number}} added",
                  defaultValue_other: "{{count, number}} added",
                })}
              </span>
            )}
            {diff && diff.stats.modified > 0 && (
              <span className="flex items-center gap-1">
                <Pencil className="h-3 w-3 shrink-0" />
                {t("version.diffChanged", {
                  count: diff.stats.modified,
                  defaultValue_one: "{{count, number}} changed",
                  defaultValue_other: "{{count, number}} changed",
                })}
              </span>
            )}
            {diff && diff.stats.removed > 0 && (
              <span className="flex items-center gap-1">
                <Minus className="h-3 w-3 shrink-0" />
                {t("version.diffRemoved", {
                  count: diff.stats.removed,
                  defaultValue_one: "{{count, number}} removed",
                  defaultValue_other: "{{count, number}} removed",
                })}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Content at this version */}
      <div className="flex-1 overflow-hidden bg-background">
        {blocks ? (
          <MountedEditor
            snapshot={blocks}
            pageId={`preview-${version.id}`}
            readonly
            className="h-full"
            onEditorReady={setEditor}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {isLoading
              ? t("snapshot.buildingVersion", "Building this version…")
              : t("snapshot.emptyVersion", "This version has no content")}
          </div>
        )}
      </div>

      {/* Footer: actions */}
      <div
        className={`flex items-center gap-2 p-3 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 ${
          forkOnly ? "justify-end" : ""
        }`}
      >
        {!forkOnly && (
          <Button
            onClick={onRestore}
            size="lg"
            className="flex-1"
            disabled={!blocks || blocks.length === 0}
          >
            <RotateCcw className="h-4 w-4 me-1.5" />
            {t("common.restore", "Restore")}
          </Button>
        )}
        <Button
          onClick={onFork}
          size={forkOnly ? "default" : "lg"}
          variant={forkOnly ? "default" : "outline"}
          disabled={isForking || !blocks || blocks.length === 0}
          className={forkOnly ? "mr-auto" : "flex-1"}
        >
          <GitFork className="h-4 w-4 me-1.5" />
          {isForking
            ? t("snapshot.forking", "Forking...")
            : t("snapshot.fork", "Fork")}
        </Button>
      </div>
    </div>
  );
}
