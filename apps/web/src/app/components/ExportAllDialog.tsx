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
import { getPages, getPage, type IListPage } from "../api/pages.api";
import { useSpaces } from "../contexts/SpaceContext";
import {
  serializeToMarkdown,
  type Block,
  type PageMetadata,
} from "@tasfer/editor";
import { downloadFile } from "@/downloadFile";
import { collectAssetRefs } from "@tasfer/editor";
import type { IPage } from "../api/pages.api";
import { useTranslation } from "react-i18next";
import { appDataSchema } from "@/appDataSchema";
import { extFromMime, fetchImageBlob } from "@/lib/exportAssets";

interface ExportAllDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SpaceOption {
  id: string;
  name: string;
}

/** Sanitize a string for use as a filesystem name */
function sanitizeName(name: string): string {
  return (
    (name || "Untitled").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() ||
    "Untitled"
  );
}

/** Relative prefix from a file at zipPath up to the ZIP root (e.g. "Space/Page.md" → "../") */
function relativeRootPrefix(zipPath: string): string {
  return "../".repeat(zipPath.split("/").length - 1);
}

function extractPageMetadata(page: IPage): PageMetadata | undefined {
  const meta: PageMetadata = {};
  if (page.task) meta.task = true;
  if (page.scheduledAt) meta.scheduledAt = page.scheduledAt;
  if (page.duration != null) meta.duration = page.duration;
  if (page.allDay != null) meta.allDay = page.allDay;
  if (page.color) meta.color = page.color;
  return Object.keys(meta).length > 0 ? meta : undefined;
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
      const zip = new JSZip();
      const assetRefs = new Set<string>();
      const spacesToExport = allSpaces.filter((s) => selected.has(s.id));

      // Pending pages — serialized after images are fetched, so asset refs can
      // be mapped to bundled files by the serializer itself
      const pendingFiles: Array<{
        zipPath: string;
        blocks: Block[];
        metadata?: PageMetadata;
      }> = [];

      // First pass: count total pages for progress
      let totalPages = 0;
      const spacePageTrees: Array<{
        space: SpaceOption;
        pages: IListPage[];
      }> = [];

      for (const space of spacesToExport) {
        if (abortRef.current) return;
        const rootPages = await getPages(space.id, null, {
          includeTasks: true,
        });
        spacePageTrees.push({ space, pages: rootPages });
        totalPages += rootPages.length;
      }

      // Estimate total (will grow as children are discovered)
      setProgress({ done: 0, total: totalPages });
      let done = 0;

      /** Deduplicate a name within a set of used names in the same directory */
      function deduplicateName(name: string, usedNames: Set<string>): string {
        if (!usedNames.has(name)) {
          usedNames.add(name);
          return name;
        }
        let i = 2;
        while (usedNames.has(`${name} ${i}`)) i++;
        const unique = `${name} ${i}`;
        usedNames.add(unique);
        return unique;
      }

      /** Recursively export pages under a given path.
       *  reservedName is the parent's self-named file (e.g. "Foo" when inside Foo/) */
      async function exportPages(
        spaceId: string,
        pages: IListPage[],
        parentPath: string,
        reservedName?: string,
      ) {
        const usedNames = new Set<string>();
        // Reserve the parent's own name so children can't collide with it
        if (reservedName) usedNames.add(reservedName);

        for (const listPage of pages) {
          if (abortRef.current) return;

          const baseName = sanitizeName(listPage.title);
          const pageName = deduplicateName(baseName, usedNames);

          // Fetch full page content
          const fullPage = await getPage(listPage.id);
          const blocks = fullPage.blocks || [];
          const metadata = extractPageMetadata(fullPage);

          for (const ref of collectAssetRefs(blocks, appDataSchema)) {
            assetRefs.add(ref);
          }

          const zipPath = listPage.hasChildren
            ? `${parentPath}${pageName}/${pageName}.md`
            : `${parentPath}${pageName}.md`;

          pendingFiles.push({ zipPath, blocks, metadata });

          if (listPage.hasChildren) {
            const children = await getPages(spaceId, listPage.id, {
              includeTasks: true,
            });
            setProgress((prev) => ({
              ...prev,
              total: prev.total + children.length,
            }));
            await exportPages(
              spaceId,
              children,
              `${parentPath}${pageName}/`,
              pageName,
            );
          }

          done++;
          setProgress((prev) => ({ ...prev, done }));
        }
      }

      // Export each space
      for (const { space, pages } of spacePageTrees) {
        if (abortRef.current) return;
        const spacePath = `${sanitizeName(space.name)}/`;
        await exportPages(space.id, pages, spacePath);
      }

      // Fetch all images into the ZIP and build ref→filename map
      const refToFileName = new Map<string, string>();

      if (assetRefs.size > 0) {
        setProgress((prev) => ({
          done: prev.done,
          total: prev.total + assetRefs.size,
        }));
      }

      let imgIndex = 0;
      for (const ref of assetRefs) {
        if (abortRef.current) return;
        const blob = await fetchImageBlob(ref);
        if (blob) {
          const ext = extFromMime(blob.type);
          // Asset hashes double as stable filenames; other refs (e.g. external
          // urls) get an indexed name
          const fileName = /^[\w-]+$/.test(ref)
            ? `${ref}.${ext}`
            : `image_${imgIndex++}.${ext}`;
          refToFileName.set(ref, fileName);
          zip.file(`images/${fileName}`, blob);
        }
        done++;
        setProgress((prev) => ({ ...prev, done }));
      }

      if (abortRef.current) return;

      // Serialize each page, pointing asset refs at the bundled files.
      // Unfetched refs keep their original url.
      for (const { zipPath, blocks, metadata } of pendingFiles) {
        const toRoot = relativeRootPrefix(zipPath);
        const markdown = serializeToMarkdown(blocks, metadata, {
          schema: appDataSchema,
          mapAssetUrl: (url) => {
            const fileName = refToFileName.get(url);
            return fileName ? `${toRoot}images/${fileName}` : url;
          },
        });
        zip.file(zipPath, markdown);
      }

      // Generate and download
      const blob = await zip.generateAsync({ type: "blob" });
      await downloadFile(blob, "tasfer-export.zip", "application/zip");

      onOpenChange(false);
    } catch (err) {
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
      <DialogContent>
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
