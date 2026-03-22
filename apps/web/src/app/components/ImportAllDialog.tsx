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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Upload } from "lucide-react";
import { createPage, updatePage } from "../api/pages.api";
import { uploadImage } from "../api/images.api";
import { useSpaces } from "../contexts/SpaceContext";
import { useQueryClient } from "@tanstack/react-query";
import tokenizePage from "@/deserializer/tokenizer";
import parsePage from "@/deserializer/parser";
import { parseFrontmatter } from "@/deserializer/loadPage";
import { extractTitleFromBlocks } from "@/editor/sync/char-runs";
import { useTranslation } from "react-i18next";

interface ImportAllDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SpaceOption {
  id: string;
  name: string;
}

interface PageNode {
  name: string;
  zipPath: string;
  children: PageNode[];
}

interface ImportResult {
  pagesCreated: number;
  imagesUploaded: number;
  errors: string[];
}

/** Guess MIME type from file extension */
function guessMimeType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
  };
  return map[ext || ""] || "application/octet-stream";
}

/** Replace ./images/{filename} with /api/images/{newId} in markdown */
function rewriteImageUrls(
  markdown: string,
  imageUrlMap: Map<string, string>,
): string {
  return markdown.replace(
    /\.\/images\/([^)"/?#\s]+)/g,
    (_match, fileName) => {
      return imageUrlMap.get(fileName) || `./images/${fileName}`;
    },
  );
}

/**
 * Build a page tree from ZIP entries.
 * The export format uses space-level folders as the first segment.
 * We strip those and merge everything into the target space.
 */
function buildPageTree(zip: JSZip): {
  imageEntries: Array<{ path: string; entry: JSZip.JSZipObject }>;
  roots: PageNode[];
} {
  const imageEntries: Array<{ path: string; entry: JSZip.JSZipObject }> = [];
  const mdFiles: Array<{ stripped: string; fullPath: string }> = [];

  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;

    if (relativePath.startsWith("images/")) {
      imageEntries.push({ path: relativePath, entry });
      return;
    }

    if (!relativePath.endsWith(".md")) return;

    // Strip the first directory segment (space folder)
    const parts = relativePath.split("/");
    if (parts.length >= 2) {
      mdFiles.push({
        stripped: parts.slice(1).join("/"),
        fullPath: relativePath,
      });
    } else {
      // No space folder — treat as root-level
      mdFiles.push({ stripped: relativePath, fullPath: relativePath });
    }
  });

  // Build a map from stripped path to full ZIP path
  const pathMap = new Map<string, string>();
  for (const f of mdFiles) {
    pathMap.set(f.stripped, f.fullPath);
  }

  function buildLevel(paths: string[]): PageNode[] {
    const nodes: PageNode[] = [];
    const directFiles: string[] = [];
    const subdirs = new Map<string, string[]>();

    for (const p of paths) {
      const parts = p.split("/");
      if (parts.length === 1) {
        directFiles.push(p);
      } else {
        const dir = parts[0];
        const rest = parts.slice(1).join("/");
        if (!subdirs.has(dir)) subdirs.set(dir, []);
        subdirs.get(dir)!.push(rest);
      }
    }

    // Process direct files as leaf pages
    for (const file of directFiles) {
      const name = file.replace(/\.md$/, "");
      // Skip if this will be handled as a self-named file in a parent dir
      nodes.push({
        name,
        zipPath: pathMap.get(file) || file,
        children: [],
      });
    }

    // Process subdirectories
    for (const [dir, contents] of subdirs) {
      const selfFile = `${dir}.md`;
      const hasSelfFile = contents.includes(selfFile);
      const childPaths = contents.filter((c) => c !== selfFile);

      if (hasSelfFile) {
        const fullChildren = buildLevelWithPrefix(childPaths, `${dir}/`);

        const selfStripped = `${dir}/${selfFile}`;
        nodes.push({
          name: dir,
          zipPath: pathMap.get(selfStripped) || selfStripped,
          children: fullChildren,
        });
      } else {
        // Directory without self-named file — recurse
        const innerPaths = contents.map((c) => c);
        // We need to properly update the pathMap lookups for inner paths
        const innerNodes = buildLevelWithPrefix(innerPaths, `${dir}/`);
        nodes.push(...innerNodes);
      }
    }

    return nodes;
  }

  function buildLevelWithPrefix(paths: string[], prefix: string): PageNode[] {
    const nodes: PageNode[] = [];
    const directFiles: string[] = [];
    const subdirs = new Map<string, string[]>();

    for (const p of paths) {
      const parts = p.split("/");
      if (parts.length === 1) {
        directFiles.push(p);
      } else {
        const dir = parts[0];
        const rest = parts.slice(1).join("/");
        if (!subdirs.has(dir)) subdirs.set(dir, []);
        subdirs.get(dir)!.push(rest);
      }
    }

    for (const file of directFiles) {
      const name = file.replace(/\.md$/, "");
      const stripped = `${prefix}${file}`;
      nodes.push({
        name,
        zipPath: pathMap.get(stripped) || stripped,
        children: [],
      });
    }

    for (const [dir, contents] of subdirs) {
      const selfFile = `${dir}.md`;
      const hasSelfFile = contents.includes(selfFile);
      const childPaths = contents.filter((c) => c !== selfFile);

      if (hasSelfFile) {
        const fullChildren = buildLevelWithPrefix(
          childPaths,
          `${prefix}${dir}/`,
        );
        const selfStripped = `${prefix}${dir}/${selfFile}`;
        nodes.push({
          name: dir,
          zipPath: pathMap.get(selfStripped) || selfStripped,
          children: fullChildren,
        });
      } else {
        const innerNodes = buildLevelWithPrefix(
          contents,
          `${prefix}${dir}/`,
        );
        nodes.push(...innerNodes);
      }
    }

    return nodes;
  }

  const strippedPaths = mdFiles.map((f) => f.stripped);
  const roots = buildLevel(strippedPaths);
  return { imageEntries, roots };
}

export function ImportAllDialog({ open, onOpenChange }: ImportAllDialogProps) {
  const { t } = useTranslation();
  const { spaces } = useSpaces();
  const queryClient = useQueryClient();

  const allSpaces: SpaceOption[] = React.useMemo(() => {
    return spaces.map((s) => ({ id: s.id, name: s.name }));
  }, [spaces]);

  const [selectedSpaceId, setSelectedSpaceId] = useState<string>("");
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<"select" | "importing" | "done">(
    "select",
  );
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const abortRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize when dialog opens
  React.useEffect(() => {
    if (open) {
      setSelectedSpaceId(allSpaces[0]?.id || "");
      setFiles([]);
      setPhase("select");
      setProgress({ done: 0, total: 0 });
      setResult(null);
      setError(null);
      setIsDragging(false);
      abortRef.current = false;
    }
  }, [open, allSpaces]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = Array.from(e.dataTransfer.files).filter(
      (f) =>
        f.name.endsWith(".zip") ||
        f.name.endsWith(".md") ||
        f.name.endsWith(".txt"),
    );
    if (dropped.length > 0) {
      setFiles(dropped);
      setError(null);
    } else {
      setError(t("import.pleaseSelectFiles", "Please select .zip, .md, or .txt files"));
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files;
      if (selected && selected.length > 0) {
        setFiles(Array.from(selected));
        setError(null);
      }
      e.target.value = "";
    },
    [],
  );

  const handleImport = useCallback(async () => {
    if (files.length === 0 || !selectedSpaceId) return;

    setPhase("importing");
    setError(null);

    const importResult: ImportResult = {
      pagesCreated: 0,
      imagesUploaded: 0,
      errors: [],
    };

    try {
      if (files.length === 1 && files[0].name.endsWith(".zip")) {
        await importZip(files[0], selectedSpaceId, importResult);
      } else {
        const mdFiles = files.filter(
          (f) => f.name.endsWith(".md") || f.name.endsWith(".txt"),
        );
        await importMarkdownFiles(mdFiles, selectedSpaceId, importResult);
      }

      if (!abortRef.current) {
        setResult(importResult);
        setPhase("done");
        // Invalidate page queries to refresh sidebar
        queryClient.invalidateQueries({ queryKey: ["pages"] });
      }
    } catch (err) {
      if (!abortRef.current) {
        setError(err instanceof Error ? err.message : t("import.failed", "Import failed"));
        setPhase("select");
      }
    }
  }, [files, selectedSpaceId, queryClient]);

  async function importZip(
    file: File,
    spaceId: string,
    importResult: ImportResult,
  ) {
    const zipData = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(zipData);

    const { imageEntries, roots } = buildPageTree(zip);

    if (roots.length === 0) {
      throw new Error(t("import.noImportablePages", "No importable pages found in the ZIP file"));
    }

    const totalItems = countNodes(roots) + imageEntries.length;
    setProgress({ done: 0, total: totalItems });
    let done = 0;

    // Step 1: Upload images and build URL map
    const imageUrlMap = new Map<string, string>();

    for (const { path, entry } of imageEntries) {
      if (abortRef.current) return;

      const fileName = path.split("/").pop()!;
      try {
        const blob = await entry.async("blob");
        const mimeType = guessMimeType(fileName);
        const imageFile = new File([blob], fileName, { type: mimeType });
        const uploaded = await uploadImage(imageFile);
        imageUrlMap.set(fileName, uploaded.id);
        importResult.imagesUploaded++;
      } catch {
        importResult.errors.push(`Failed to upload image: ${fileName}`);
      }

      done++;
      setProgress((prev) => ({ ...prev, done }));
    }

    // Step 2: Create pages top-down
    async function createPages(
      nodes: PageNode[],
      parentId: string | null,
    ) {
      for (const node of nodes) {
        if (abortRef.current) return;

        try {
          const zipEntry = zip.file(node.zipPath);
          if (!zipEntry) {
            importResult.errors.push(
              `File not found in ZIP: ${node.zipPath}`,
            );
            done++;
            setProgress((prev) => ({ ...prev, done }));
            continue;
          }

          const mdContent = await zipEntry.async("string");
          const rewritten = rewriteImageUrls(mdContent, imageUrlMap);
          const { content: body, metadata } = parseFrontmatter(rewritten);
          const tokens = tokenizePage(body);
          const page = parsePage(tokens);
          const title = extractTitleFromBlocks(page.blocks) || node.name;

          const createdPage = await createPage({
            title,
            parentId,
            spaceId,
            ...(metadata?.task && { task: true }),
            ...(metadata?.scheduledAt && { scheduledAt: metadata.scheduledAt }),
            ...(metadata?.duration != null && { duration: metadata.duration }),
            ...(metadata?.allDay != null && { allDay: metadata.allDay }),
          });
          await updatePage({
            id: createdPage.id,
            snapshot: page.blocks,
            ...(metadata?.color && { color: metadata.color }),
          });

          importResult.pagesCreated++;
          done++;
          setProgress((prev) => ({ ...prev, done }));

          // Recurse for children
          if (node.children.length > 0) {
            await createPages(node.children, createdPage.id);
          }
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Unknown error";
          importResult.errors.push(
            `Failed to import page "${node.name}": ${msg}`,
          );
          done++;
          setProgress((prev) => ({ ...prev, done }));
        }
      }
    }

    await createPages(roots, null);
  }

  async function importMarkdownFiles(
    mdFiles: File[],
    spaceId: string,
    importResult: ImportResult,
  ) {
    setProgress({ done: 0, total: mdFiles.length });
    let done = 0;

    for (const file of mdFiles) {
      if (abortRef.current) return;

      try {
        const rawContent = await file.text();
        const { content: body, metadata } = parseFrontmatter(rawContent);
        const tokens = tokenizePage(body);
        const page = parsePage(tokens);
        const nameWithoutExt = file.name.replace(/\.(md|txt)$/, "");
        const title = extractTitleFromBlocks(page.blocks) || nameWithoutExt;

        const createdPage = await createPage({
          title,
          parentId: null,
          spaceId,
          ...(metadata?.task && { task: true }),
          ...(metadata?.scheduledAt && { scheduledAt: metadata.scheduledAt }),
          ...(metadata?.duration != null && { duration: metadata.duration }),
          ...(metadata?.allDay != null && { allDay: metadata.allDay }),
        });
        await updatePage({
          id: createdPage.id,
          snapshot: page.blocks,
          ...(metadata?.color && { color: metadata.color }),
        });

        importResult.pagesCreated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        importResult.errors.push(
          `Failed to import "${file.name}": ${msg}`,
        );
      }

      done++;
      setProgress((prev) => ({ ...prev, done }));
    }
  }

  const handleCancel = useCallback(() => {
    if (phase === "importing") {
      abortRef.current = true;
    }
    onOpenChange(false);
  }, [phase, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("import.title", "Import")}</DialogTitle>
          <DialogDescription>
            {phase === "select" &&
              t("import.fromZipOrMarkdownDesc", "Import pages from a ZIP file or markdown files.")}
            {phase === "importing" && t("import.importingPages", "Importing your pages...")}
            {phase === "done" && t("import.complete", "Import complete.")}
          </DialogDescription>
        </DialogHeader>

        {phase === "select" && (
          <>
            {/* Drop zone */}
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              className={`
                flex flex-col items-center justify-center p-8 rounded-lg border-2 border-dashed
                transition-all cursor-pointer
                ${
                  isDragging
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary hover:bg-accent"
                }
              `}
            >
              <Upload
                className={`h-10 w-10 mb-3 ${
                  isDragging ? "text-primary" : "text-muted-foreground"
                }`}
              />
              {files.length > 0 ? (
                <span className="font-medium text-center">
                  {files.length === 1
                    ? files[0].name
                    : t("format.filesSelected", { defaultValue: "{{count}} files selected", count: files.length })}
                </span>
              ) : (
                <>
                  <span className="font-medium text-center">
                    {isDragging
                      ? t("import.dropFiles", "Drop files here")
                      : t("import.dragAndDropFiles", "Drag and drop files here")}
                  </span>
                  <span className="text-sm text-muted-foreground mt-1">
                    {t("import.orClickToSelect", "or click to select")}
                  </span>
                </>
              )}
              <span className="text-xs text-muted-foreground mt-2">
                .zip, .md, .txt
              </span>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,.md,.txt"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />

            {/* Space selector */}
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {t("import.to", "Import to")}
              </span>
              <Select
                value={selectedSpaceId}
                onValueChange={setSelectedSpaceId}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder={t("space.selectSpace", "Select space")} />
                </SelectTrigger>
                <SelectContent>
                  {allSpaces.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {space.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="outline" onClick={handleCancel}>
                {t("common.cancel", "Cancel")}
              </Button>
              <Button
                onClick={handleImport}
                disabled={files.length === 0 || !selectedSpaceId}
              >
                {t("import.title", "Import")}
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === "importing" && (
          <>
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="size-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-muted-foreground">
                  {t("import.importing", "Importing...")} {progress.done}/{progress.total}
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

        {phase === "done" && result && (
          <>
            <div className="space-y-3">
              <p className="text-sm">
                {t("common.created", "Created")} {result.pagesCreated}{" "}
                {result.pagesCreated === 1 ? t("common.pageKw", "page") : t("common.pagesKw", "pages")}
                {result.imagesUploaded > 0 && (
                  <>
                    , {t("blocks.uploadedKw", "uploaded")} {result.imagesUploaded}{" "}
                    {result.imagesUploaded === 1 ? t("blocks.imageKw", "image") : t("blocks.imagesKw", "images")}
                  </>
                )}
              </p>
              {result.errors.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-destructive">
                    {result.errors.length}{" "}
                    {result.errors.length === 1 ? t("common.errorKw", "error") : t("common.errorsKw", "errors")}:
                  </p>
                  <ul className="text-xs text-muted-foreground space-y-1 max-h-32 overflow-y-auto">
                    {result.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{t("common.close", "Close")}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Count total nodes in the tree */
function countNodes(nodes: PageNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1 + countNodes(node.children);
  }
  return count;
}
