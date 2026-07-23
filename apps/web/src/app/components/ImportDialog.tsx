import JSZip from "jszip";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Upload, FileUp, FilePlus, Replace } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePageSettings } from "../contexts/PageSettingsContext";
import useResponsive from "../hooks/useResponsive";
import { tokenizePage } from "@tasfer/editor";
import { getPlatform } from "@/platform";
import { parsePage } from "@tasfer/editor";
import {
  parseFrontmatter,
  type PageMetadata,
} from "@tasfer/editor";
import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useCreatePage, updatePage } from "../api/pages.api";
import { uploadImage } from "../api/images.api";
import { useSpaces } from "../contexts/SpaceContext";
import {
  getVisibleTextFromRuns,
  isTextualBlock,
} from "@tasfer/editor/internal";
import { deriveTitles } from "@/lib/pageTitle";
import { type Block } from "@tasfer/editor";
import { appDataSchema } from "@/appDataSchema";

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function isPageEmpty(blocks: Block[]): boolean {
  if (blocks.length === 0) return true;

  // Check if all blocks have no visible content
  for (const block of blocks) {
    // Non-textual blocks (images, lines, math) count as content.
    if (!isTextualBlock(block)) {
      return false;
    }
    if ("charRuns" in block) {
      const text = getVisibleTextFromRuns(block.charRuns);
      if (text.trim() !== "") {
        return false;
      }
    }
  }

  return true;
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

export function ImportDialog({ open, onOpenChange }: ImportDialogProps) {
  const { t } = useTranslation();
  const { onRestoreSnapshot, currentBlocks } = usePageSettings();
  const isMobile = useResponsive("(max-width: 768px)");
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingBlocks, setPendingBlocks] = useState<Block[] | null>(null);
  const [pendingMetadata, setPendingMetadata] = useState<
    PageMetadata | undefined
  >(undefined);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeSpaceId } = useSpaces();

  const { mutate: createPage, isPending: isCreating } = useCreatePage({
    onSuccess: async (newPage) => {
      if (pendingBlocks) {
        // Write imported blocks as CRDT ops and update metadata
        const platform = getPlatform();
        await platform.ops.writeBlocks(newPage.id, pendingBlocks);
        await updatePage({
          id: newPage.id,
          ...(pendingMetadata?.task && { task: true }),
          ...(pendingMetadata?.color && { color: pendingMetadata.color }),
          ...(pendingMetadata?.scheduledAt && {
            scheduledAt: pendingMetadata.scheduledAt,
          }),
          ...(pendingMetadata?.duration != null && {
            duration: pendingMetadata.duration,
          }),
          ...(pendingMetadata?.allDay != null && {
            allDay: pendingMetadata.allDay,
          }),
        });
        queryClient.invalidateQueries({
          queryKey: ["pages", { parentId: null }],
        });
        // Navigate to the new page
        navigate(`/page/${newPage.id}`);
      }
      resetState();
      onOpenChange(false);
    },
    onError: () => {
      setError(t("error.failedToCreatePage", "Failed to create new page"));
    },
  });

  const resetState = useCallback(() => {
    setError(null);
    setPendingBlocks(null);
    setPendingMetadata(undefined);
    setShowConfirmation(false);
    setIsDragging(false);
  }, []);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      resetState();
    }
  }, [open, resetState]);

  const handleClose = useCallback(
    (open: boolean) => {
      if (!open) {
        resetState();
      }
      onOpenChange(open);
    },
    [onOpenChange, resetState],
  );

  const processFile = useCallback(
    async (file: File) => {
      setError(null);

      const isZip = file.name.endsWith(".zip");
      const isMd = file.name.endsWith(".md") || file.name.endsWith(".txt");

      if (!isZip && !isMd) {
        setError(
          t(
            "import.pleaseSelectFile",
            "Please select a .md, .txt, or .zip file",
          ),
        );
        return;
      }

      try {
        let markdown: string;

        if (isZip) {
          // Process ZIP: extract images, upload them, rewrite URLs in markdown
          const zipData = await file.arrayBuffer();
          const zip = await JSZip.loadAsync(zipData);

          // Find image files in images/ folder
          const imageEntries: Array<{
            fileName: string;
            entry: JSZip.JSZipObject;
          }> = [];
          zip.forEach((relativePath, entry) => {
            if (!entry.dir && relativePath.startsWith("images/")) {
              const fileName = relativePath.split("/").pop()!;
              imageEntries.push({ fileName, entry });
            }
          });

          // Upload each image and build fileName → asset-id map
          const imageUrlMap = new Map<string, string>();
          for (const { fileName, entry } of imageEntries) {
            try {
              const blob = await entry.async("blob");
              const mimeType = guessMimeType(fileName);
              const imageFile = new File([blob], fileName, { type: mimeType });
              const uploaded = await uploadImage(imageFile);
              imageUrlMap.set(fileName, uploaded.id);
            } catch {
              // Skip images that fail to upload
            }
          }

          // Find the .md file in the ZIP (prefer shallowest level)
          const mdFiles: string[] = [];
          zip.forEach((relativePath, entry) => {
            if (!entry.dir && relativePath.endsWith(".md")) {
              mdFiles.push(relativePath);
            }
          });

          if (mdFiles.length === 0) {
            setError(
              t("import.noMarkdownInZip", "No markdown file found in the ZIP"),
            );
            return;
          }

          // Prefer the shallowest .md file (root-level)
          mdFiles.sort((a, b) => a.split("/").length - b.split("/").length);
          const mdEntry = zip.file(mdFiles[0]);
          if (!mdEntry) {
            setError(
              t("import.noMarkdownInZip", "No markdown file found in the ZIP"),
            );
            return;
          }

          const mdContent = await mdEntry.async("string");

          // Rewrite relative images/ links (./images/, ../images/, …) → asset id
          markdown = mdContent.replace(
            /(?:\.\.?\/)+images\/([^)"/?#\s]+)/g,
            (match: string, fileName: string) => {
              return imageUrlMap.get(fileName) || match;
            },
          );
        } else {
          markdown = await file.text();
        }

        const { content: body, metadata } = parseFrontmatter(markdown);
        const tokens = tokenizePage(body, appDataSchema);
        const page = parsePage(tokens, appDataSchema);

        // Check if current page has content
        if (!isPageEmpty(currentBlocks)) {
          // Show confirmation dialog
          setPendingBlocks(page.blocks);
          setPendingMetadata(metadata);
          setShowConfirmation(true);
        } else {
          // Page is empty, directly replace
          if (onRestoreSnapshot) {
            onRestoreSnapshot(page.blocks);
            onOpenChange(false);
          }
        }
      } catch (error) {
        console.error("Failed to parse imported file:", error);
        setError(t("error.failedToParseFile", "Failed to parse the file"));
      }
    },
    [onRestoreSnapshot, onOpenChange, currentBlocks, t],
  );

  const handleReplaceCurrent = useCallback(() => {
    if (pendingBlocks && onRestoreSnapshot) {
      onRestoreSnapshot(pendingBlocks);
      resetState();
      onOpenChange(false);
    }
  }, [pendingBlocks, onRestoreSnapshot, onOpenChange, resetState]);

  const handleCreateNew = useCallback(() => {
    if (pendingBlocks && activeSpaceId) {
      createPage({
        ...deriveTitles(pendingBlocks),
        parentId: null,
        spaceId: activeSpaceId,
      });
    }
  }, [pendingBlocks, createPage, activeSpaceId]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const file = e.dataTransfer.files[0];
      if (file) {
        processFile(file);
      }
    },
    [processFile],
  );

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
      const file = e.target.files?.[0];
      if (file) {
        processFile(file);
      }
      // Reset input so the same file can be selected again
      e.target.value = "";
    },
    [processFile],
  );

  const handleButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".md,.txt,.zip"
      onChange={handleFileSelect}
      className="hidden"
    />
  );

  // Confirmation step content
  const confirmationContent = (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t(
          "import.contentExistsWhat",
          "This page already has content. What would you like to do?",
        )}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="grid gap-2">
        <Button
          variant="outline"
          className="w-full justify-start gap-3 h-auto py-3"
          onClick={handleCreateNew}
          disabled={isCreating}
        >
          <FilePlus className="h-5 w-5 text-muted-foreground" />
          <div className="flex flex-col items-start">
            <span className="font-medium">
              {t("page.createNewPage", "Create new page")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("import.intoNewPage", "Import into a new page")}
            </span>
          </div>
        </Button>
        <Button
          variant="outline"
          className="w-full justify-start gap-3 h-auto py-3"
          onClick={handleReplaceCurrent}
        >
          <Replace className="h-5 w-5 text-muted-foreground" />
          <div className="flex flex-col items-start">
            <span className="font-medium">
              {t("import.replaceCurrent", "Replace current")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("import.replaceContent", "Replace this page's content")}
            </span>
          </div>
        </Button>
      </div>
    </div>
  );

  // File selection content
  const fileSelectionContent = (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("import.fileTypes", "Import a markdown, text, or zip file.")}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button
        variant="outline"
        className="w-full justify-start gap-3 h-auto py-3"
        onClick={handleButtonClick}
      >
        <FileUp className="h-5 w-5 text-muted-foreground" />
        <div className="flex flex-col items-start">
          <span className="font-medium">
            {t("import.selectFile", "Select file")}
          </span>
          <span className="text-xs text-muted-foreground">.md, .txt, .zip</span>
        </div>
      </Button>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={handleClose}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm pb-6">
            <DrawerHeader>
              <DrawerTitle>
                {showConfirmation
                  ? t("import.options", "Import options")
                  : t("import.document", "Import document")}
              </DrawerTitle>
            </DrawerHeader>
            <div className="px-4">
              {showConfirmation ? confirmationContent : fileSelectionContent}
            </div>
            {fileInput}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {showConfirmation
              ? t("import.options", "Import options")
              : t("import.document", "Import document")}
          </DialogTitle>
          <DialogDescription>
            {showConfirmation
              ? t(
                  "import.contentExistsChoose",
                  "This page already has content. Choose how to proceed.",
                )
              : t("import.fileTypes", "Import a markdown, text, or zip file.")}
          </DialogDescription>
        </DialogHeader>

        {showConfirmation ? (
          <div className="space-y-3">
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={handleCreateNew}
                disabled={isCreating}
                className="flex flex-col items-center justify-center p-4 rounded-lg border-2 border-border hover:border-primary hover:bg-accent transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <FilePlus className="h-8 w-8 mb-2 text-muted-foreground" />
                <span className="font-medium">
                  {t("page.newPage", "New page")}
                </span>
                <span className="text-xs text-muted-foreground text-center">
                  {t("common.createNew", "Create new")}
                </span>
              </button>
              <button
                onClick={handleReplaceCurrent}
                className="flex flex-col items-center justify-center p-4 rounded-lg border-2 border-border hover:border-primary hover:bg-accent transition-all cursor-pointer"
              >
                <Replace className="h-8 w-8 mb-2 text-muted-foreground" />
                <span className="font-medium">
                  {t("common.replace", "Replace")}
                </span>
                <span className="text-xs text-muted-foreground text-center">
                  {t("page.currentPage", "Current page")}
                </span>
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              data-file-drop-scope="local"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={handleButtonClick}
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
              <span className="font-medium text-center">
                {isDragging
                  ? t("import.dropFile", "Drop file here")
                  : t("import.dragAndDropFile", "Drag and drop a file here")}
              </span>
              <span className="text-sm text-muted-foreground mt-1">
                {t("import.orClickToSelect", "or click to select")}
              </span>
              <span className="text-xs text-muted-foreground mt-2">
                .md, .txt, .zip
              </span>
            </div>
            {error && (
              <p className="text-sm text-destructive text-center">{error}</p>
            )}
          </>
        )}

        {fileInput}
      </DialogContent>
    </Dialog>
  );
}
