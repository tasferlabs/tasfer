import React, { useState, useRef, useCallback } from "react";
import JSZip from "jszip";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { getPages, getPage } from "../api/pages.api";
import { useSpaces } from "../contexts/SpaceContext";
import { downloadFile } from "@/downloadFile";
import { useTranslation } from "react-i18next";
import { fetchImageBlob } from "@/lib/exportAssets";
import { buildSpaceExport, sanitizeName } from "@/lib/spaceExport";
import type { IListPage } from "../api/pages.api";
import { ChevronRight } from "lucide-react";
import { TitlePreview } from "../TitlePreview";

interface ExportAllDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * With `page`, export only that page and its subpages from `spaceId`, and
   * hide the space checklist. When omitted, the user picks whole spaces.
   */
  spaceId?: string;
  page?: IListPage | null;
}

interface SpaceOption {
  id: string;
  name: string;
}

export function ExportAllDialog({
  open,
  onOpenChange,
  spaceId,
  page,
}: ExportAllDialogProps) {
  const { t } = useTranslation();
  const { spaces } = useSpaces();

  const allSpaces: SpaceOption[] = React.useMemo(() => {
    return spaces.map((s) => ({ id: s.id, name: s.name }));
  }, [spaces]);

  const pageSpace = page ? allSpaces.find((s) => s.id === spaceId) : undefined;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<"select" | "exporting">("select");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(false);

  // Initialize all selected when dialog opens
  React.useEffect(() => {
    if (open) {
      setSelected(new Set(allSpaces.map((s) => s.id)));
      setPhase("select");
      setProgress({ done: 0, total: 0 });
      setError(null);
      abortRef.current = false;
    }
  }, [open, allSpaces]);

  const toggleSpace = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleExport = useCallback(async () => {
    setPhase("exporting");
    setError(null);

    try {
      const entries = await buildSpaceExport({
        spaces:
          page && pageSpace
            ? [{ ...pageSpace, rootPage: page }]
            : allSpaces.filter((s) => selected.has(s.id)),
        source: {
          listPages: (spaceId, parentId) =>
            getPages(spaceId, parentId, { includeTasks: true }),
          getPage,
          fetchAsset: async (ref) => {
            const blob = await fetchImageBlob(ref);
            if (!blob) return null;
            return {
              data: new Uint8Array(await blob.arrayBuffer()),
              mime: blob.type,
            };
          },
        },
        onProgress: setProgress,
        isAborted: () => abortRef.current,
      });

      const zip = new JSZip();
      for (const entry of entries) zip.file(entry.path, entry.data);

      const blob = await zip.generateAsync({ type: "blob" });
      const fileName = page
        ? `${sanitizeName(page.title)}.zip`
        : "tasfer-export.zip";
      await downloadFile(blob, fileName, "application/zip");

      onOpenChange(false);
    } catch (err) {
      // A cancel unwinds through here too; the dialog is already closing.
      if (!abortRef.current) {
        setError(
          err instanceof Error
            ? err.message
            : t("export.failed", "Export failed"),
        );
        setPhase("select");
      }
    }
  }, [allSpaces, selected, onOpenChange, page, pageSpace]);

  const handleCancel = useCallback(() => {
    if (phase === "exporting") {
      abortRef.current = true;
    }
    onOpenChange(false);
  }, [phase, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Work in flight is stopped by Cancel and nothing else: an
        // outside click or Escape would only hide the progress while
        // the run kept going.
        onInteractOutside={(e) => {
          if (phase === "exporting") e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (phase === "exporting") e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {page
              ? t("export.page", "Export page")
              : t("export.all", "Export all")}
          </DialogTitle>
          <DialogDescription>
            {phase !== "select"
              ? t("export.exportingPages", "Exporting your pages...")
              : page
                ? t(
                    "export.pageAsZip",
                    "Export this page and its subpages as a ZIP file.",
                  )
                : t(
                    "export.selectSpaces",
                    "Select spaces to export as a ZIP file.",
                  )}
          </DialogDescription>
        </DialogHeader>

        {phase === "select" && (
          <>
            {page ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="whitespace-nowrap text-muted-foreground">
                  {t("export.exportingFrom", "Exporting")}
                </span>
                <span className="flex min-w-0 items-center gap-1 font-medium">
                  <span className="truncate">
                    {pageSpace?.name || t("common.untitled", "Untitled")}
                  </span>
                  <ChevronRight
                    size={14}
                    className="shrink-0 text-muted-foreground rtl:rotate-180"
                  />
                  <span className="truncate">
                    <TitlePreview title={page.title} titleMd={page.titleMd} />
                  </span>
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                {allSpaces.map((space) => (
                  <label
                    key={space.id}
                    className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-accent cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(space.id)}
                      onChange={() => toggleSpace(space.id)}
                      className="size-4 rounded border-border accent-primary"
                    />
                    <span className="text-sm font-medium">
                      {space.name || t("common.untitled", "Untitled")}
                    </span>
                    <span className="text-xs text-muted-foreground ms-auto">
                      {t("space.space", "Space")}
                    </span>
                  </label>
                ))}
                {allSpaces.length === 0 && (
                  <p className="text-sm text-muted-foreground py-2">
                    {t("space.noSpacesFound", "No spaces found.")}
                  </p>
                )}
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="outline" onClick={handleCancel}>
                {t("common.cancel", "Cancel")}
              </Button>
              <Button
                onClick={handleExport}
                disabled={page ? !pageSpace : selected.size === 0}
              >
                {t("export.title", "Export")}
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === "exporting" && (
          <>
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="size-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-muted-foreground">
                  {t("export.exporting", "Exporting...")} {progress.done}/
                  {progress.total}
                </span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300 rounded-full"
                  style={{
                    width:
                      progress.total > 0
                        ? `${Math.round((progress.done / progress.total) * 100)}%`
                        : "0%",
                  }}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleCancel}>
                {t("common.cancel", "Cancel")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
