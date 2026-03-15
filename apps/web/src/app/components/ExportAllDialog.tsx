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
import { authFetch, API_BASE } from "../api/client";
import { useSpaces } from "../contexts/SpaceContext";
import { serializeToMarkdown, type PageMetadata } from "../../deserializer/serializer";
import { downloadFile } from "@/downloadFile";
import type { Image } from "../../deserializer/loadPage";
import type { IPage } from "../api/pages.api";
import { useTranslation } from "react-i18next";

interface ExportAllDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SpaceOption {
  id: string;
  name: string;
  type: "personal" | "group";
}

/** Sanitize a string for use as a filesystem name */
function sanitizeName(name: string): string {
  return (name || "Untitled").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "Untitled";
}

/** Extract image ID from a URL like /api/images/{id} */
function extractImageId(url: string): string | null {
  const match = url.match(/\/api\/images\/([^/?#]+)/);
  return match ? match[1] : null;
}

/** Guess file extension from mime type */
function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
  };
  return map[mime] || "bin";
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
  const { personalSpace, groupSpaces } = useSpaces();

  const allSpaces: SpaceOption[] = React.useMemo(() => {
    const spaces: SpaceOption[] = [];
    if (personalSpace) {
      spaces.push({ id: personalSpace.id, name: t("Private"), type: "personal" });
    }
    for (const g of groupSpaces) {
      spaces.push({ id: g.id, name: g.name, type: "group" });
    }
    return spaces;
  }, [personalSpace, groupSpaces]);

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
      const imageIds = new Set<string>();
      const spacesToExport = allSpaces.filter((s) => selected.has(s.id));

      // Pending markdown entries — rewritten after images are fetched
      const pendingFiles: Array<{ zipPath: string; markdown: string }> = [];

      // First pass: count total pages for progress
      let totalPages = 0;
      const spacePageTrees: Array<{
        space: SpaceOption;
        pages: IListPage[];
      }> = [];

      for (const space of spacesToExport) {
        if (abortRef.current) return;
        const rootPages = await getPages(space.id, null, { includeTasks: true });
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
          const blocks = fullPage.snapshot || [];
          const metadata = extractPageMetadata(fullPage);
          const markdown = serializeToMarkdown(blocks, metadata);

          // Collect image IDs from blocks
          for (const block of blocks) {
            if (block.type === "image") {
              const imgBlock = block as Image;
              const imgId = extractImageId(imgBlock.url);
              if (imgId) imageIds.add(imgId);
            }
          }

          // Also collect image IDs from markdown text (inline images)
          const mdImgRegex = /\/api\/images\/([^)"/?#\s]+)/g;
          let mdMatch;
          while ((mdMatch = mdImgRegex.exec(markdown)) !== null) {
            imageIds.add(mdMatch[1]);
          }

          const zipPath = listPage.hasChildren
            ? `${parentPath}${pageName}/${pageName}.md`
            : `${parentPath}${pageName}.md`;

          pendingFiles.push({ zipPath, markdown });

          if (listPage.hasChildren) {
            const children = await getPages(spaceId, listPage.id, { includeTasks: true });
            setProgress((prev) => ({ ...prev, total: prev.total + children.length }));
            await exportPages(spaceId, children, `${parentPath}${pageName}/`, pageName);
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

      // Fetch all images and build id→filename map
      const imageExtMap = new Map<string, string>(); // id → "id.ext"

      if (imageIds.size > 0) {
        setProgress((prev) => ({
          done: prev.done,
          total: prev.total + imageIds.size,
        }));
      }

      for (const imgId of imageIds) {
        if (abortRef.current) return;
        try {
          const response = await authFetch(`${API_BASE}/images/${imgId}`);
          if (response.ok) {
            const blob = await response.blob();
            const contentType = response.headers.get("content-type") || "image/png";
            const ext = extFromMime(contentType);
            const fileName = `${imgId}.${ext}`;
            imageExtMap.set(imgId, fileName);
            zip.file(`images/${fileName}`, blob);
          }
        } catch {
          // Skip images that fail to fetch
        }
        done++;
        setProgress((prev) => ({ ...prev, done }));
      }

      if (abortRef.current) return;

      // Rewrite image URLs in markdown and add to ZIP
      for (const { zipPath, markdown } of pendingFiles) {
        const rewritten = markdown.replace(
          /\/api\/images\/([^)"/?#\s]+)/g,
          (_match, id) => {
            const fileName = imageExtMap.get(id);
            return fileName ? `./images/${fileName}` : `./images/${id}`;
          },
        );
        zip.file(zipPath, rewritten);
      }

      // Generate and download
      const blob = await zip.generateAsync({ type: "blob" });
      await downloadFile(blob, "cypher-export.zip", "application/zip");

      onOpenChange(false);
    } catch (err) {
      if (!abortRef.current) {
        setError(err instanceof Error ? err.message : t("Export failed"));
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
          <DialogTitle>{t("Export all")}</DialogTitle>
          <DialogDescription>
            {phase === "select"
              ? t("Select spaces to export as a ZIP file.")
              : t("Exporting your pages...")}
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
                  <span className="text-sm font-medium">{space.name}</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {space.type === "personal" ? t("Personal") : t("Space")}
                  </span>
                </label>
              ))}
              {allSpaces.length === 0 && (
                <p className="text-sm text-muted-foreground py-2">
                  {t("No spaces found.")}
                </p>
              )}
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={handleCancel}>
                {t("Cancel")}
              </Button>
              <Button
                onClick={handleExport}
                disabled={selected.size === 0}
              >
                {t("Export")}
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
                  {t("Exporting...")} {progress.done}/{progress.total}
                </span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300 rounded-full"
                  style={{
                    width: progress.total > 0
                      ? `${Math.round((progress.done / progress.total) * 100)}%`
                      : "0%",
                  }}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleCancel}>
                {t("Cancel")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
