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
import { buildSpaceExport } from "@/lib/spaceExport";

interface ExportAllDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SpaceOption {
  id: string;
  name: string;
}

export function ExportAllDialog({ open, onOpenChange }: ExportAllDialogProps) {
  const { t } = useTranslation();
  const { spaces } = useSpaces();

  const allSpaces: SpaceOption[] = React.useMemo(() => {
    return spaces.map((s) => ({ id: s.id, name: s.name }));
  }, [spaces]);

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
        spaces: allSpaces.filter((s) => selected.has(s.id)),
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
      await downloadFile(blob, "tasfer-export.zip", "application/zip");

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
  }, [allSpaces, selected, onOpenChange]);

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
          <DialogTitle>{t("export.all", "Export all")}</DialogTitle>
          <DialogDescription>
            {phase === "select"
              ? t(
                  "export.selectSpaces",
                  "Select spaces to export as a ZIP file.",
                )
              : t("export.exportingPages", "Exporting your pages...")}
          </DialogDescription>
        </DialogHeader>

        {phase === "select" && (
          <>
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

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="outline" onClick={handleCancel}>
                {t("common.cancel", "Cancel")}
              </Button>
              <Button onClick={handleExport} disabled={selected.size === 0}>
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
