import { Button } from "@/components/ui/button";
import type { Block } from "@tasfer/editor";
import { ChevronLeft, FileText, GitFork, Layers, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MountedEditor } from "../MountedEditor";

interface SnapshotPreviewProps {
  snapshot: {
    id: string;
    versionNumber: number;
    opCount: number;
    blockCount: number;
    blocks: Block[];
  };
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
  snapshot,
  onBack,
  onRestore,
  onFork,
  isForking,
  forkOnly,
}: SnapshotPreviewProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col h-full flex-1">
      {/* Header: back + version info */}
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
            {t("common.version", "Version")} {snapshot.versionNumber}
          </h3>
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Layers className="h-3 w-3 shrink-0" />
              {t("snapshot.operationsCount", {
                count: snapshot.opCount,
                defaultValue_one: "{{count, number}} operation",
                defaultValue_other: "{{count, number}} operations",
              })}
            </span>
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3 shrink-0" />
              {t("blocks.blocksCount", {
                count: snapshot.blockCount,
                defaultValue_one: "{{count, number}} block",
                defaultValue_other: "{{count, number}} blocks",
              })}
            </span>
          </div>
        </div>
      </div>

      {/* Editor Preview */}
      <div className="flex-1 overflow-hidden bg-background">
        <MountedEditor
          snapshot={snapshot.blocks}
          pageId={`preview-${snapshot.id}`}
          readonly
          className="h-full"
        />
      </div>

      {/* Footer: actions */}
      <div
        className={`flex items-center gap-2 p-3 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 ${
          forkOnly ? "justify-end" : ""
        }`}
      >
        {!forkOnly && (
          <Button onClick={onRestore} size="lg" className="flex-1">
            <RotateCcw className="h-4 w-4 me-1.5" />
            {t("common.restore", "Restore")}
          </Button>
        )}
        <Button
          onClick={onFork}
          size={forkOnly ? "default" : "lg"}
          variant={forkOnly ? "default" : "outline"}
          disabled={isForking}
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
