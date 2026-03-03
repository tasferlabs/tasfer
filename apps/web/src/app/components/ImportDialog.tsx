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
import tokenizePage from "@/deserializer/tokenizer";
import parsePage from "@/deserializer/parser";
import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useCreatePage, updatePage } from "../api/pages.api";
import { useSpaces } from "../contexts/SpaceContext";
import { extractTitleFromBlocks, getVisibleTextFromRuns } from "@/editor/sync/char-runs";
import type { Block } from "@/deserializer/loadPage";

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function isPageEmpty(blocks: Block[]): boolean {
  if (blocks.length === 0) return true;

  // Check if all blocks have no visible content
  for (const block of blocks) {
    // Images and lines count as content
    if (block.type === "image" || block.type === "line") {
      return false;
    }
    // Check textual blocks for content
    if ("charRuns" in block) {
      const text = getVisibleTextFromRuns(block.charRuns);
      if (text.trim() !== "") {
        return false;
      }
    }
  }

  return true;
}

export function ImportDialog({ open, onOpenChange }: ImportDialogProps) {
  const { t } = useTranslation();
  const { onRestoreSnapshot, currentBlocks } = usePageSettings();
  const isMobile = useResponsive("(max-width: 768px)");
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingBlocks, setPendingBlocks] = useState<Block[] | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeSpaceId } = useSpaces();

  const { mutate: createPage, isPending: isCreating } = useCreatePage({
    onSuccess: async (newPage) => {
      if (pendingBlocks) {
        // Update the new page with the imported blocks
        await updatePage({
          id: newPage.id,
          snapshot: pendingBlocks,
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
      setError(t`Failed to create new page`);
    },
  });

  const resetState = useCallback(() => {
    setError(null);
    setPendingBlocks(null);
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
    [onOpenChange, resetState]
  );

  const processFile = useCallback(
    async (file: File) => {
      setError(null);

      if (!file.name.endsWith(".md") && !file.name.endsWith(".txt")) {
        setError(t`Please select a markdown (.md) or text (.txt) file`);
        return;
      }

      try {
        const content = await file.text();
        const tokens = tokenizePage(content);
        const page = parsePage(tokens);

        // Check if current page has content
        if (!isPageEmpty(currentBlocks)) {
          // Show confirmation dialog
          setPendingBlocks(page.blocks);
          setShowConfirmation(true);
        } else {
          // Page is empty, directly replace
          if (onRestoreSnapshot) {
            onRestoreSnapshot(page.blocks);
            onOpenChange(false);
          }
        }
      } catch {
        setError(t`Failed to parse the file`);
      }
    },
    [onRestoreSnapshot, onOpenChange, currentBlocks, t]
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
      const title = extractTitleFromBlocks(pendingBlocks) || "";
      createPage({ title, parentId: null, spaceId: activeSpaceId });
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
    [processFile]
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
    [processFile]
  );

  const handleButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".md,.txt"
      onChange={handleFileSelect}
      className="hidden"
    />
  );

  // Confirmation step content
  const confirmationContent = (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t`This page already has content. What would you like to do?`}
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
            <span className="font-medium">{t`Create new page`}</span>
            <span className="text-xs text-muted-foreground">
              {t`Import into a new page`}
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
            <span className="font-medium">{t`Replace current`}</span>
            <span className="text-xs text-muted-foreground">
              {t`Replace this page's content`}
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
        {t`Import a markdown or text file.`}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button
        variant="outline"
        className="w-full justify-start gap-3 h-auto py-3"
        onClick={handleButtonClick}
      >
        <FileUp className="h-5 w-5 text-muted-foreground" />
        <div className="flex flex-col items-start">
          <span className="font-medium">{t`Select file`}</span>
          <span className="text-xs text-muted-foreground">.md, .txt</span>
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
                {showConfirmation ? t`Import options` : t`Import document`}
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
            {showConfirmation ? t`Import options` : t`Import document`}
          </DialogTitle>
          <DialogDescription>
            {showConfirmation
              ? t`This page already has content. Choose how to proceed.`
              : t`Import a markdown or text file.`}
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
                <span className="font-medium">{t`New page`}</span>
                <span className="text-xs text-muted-foreground text-center">
                  {t`Create new`}
                </span>
              </button>
              <button
                onClick={handleReplaceCurrent}
                className="flex flex-col items-center justify-center p-4 rounded-lg border-2 border-border hover:border-primary hover:bg-accent transition-all cursor-pointer"
              >
                <Replace className="h-8 w-8 mb-2 text-muted-foreground" />
                <span className="font-medium">{t`Replace`}</span>
                <span className="text-xs text-muted-foreground text-center">
                  {t`Current page`}
                </span>
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
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
                {isDragging ? t`Drop file here` : t`Drag and drop a file here`}
              </span>
              <span className="text-sm text-muted-foreground mt-1">
                {t`or click to select`}
              </span>
              <span className="text-xs text-muted-foreground mt-2">
                .md, .txt
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
