import React, { useState, useRef, useCallback } from "react";
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
import { useSpaces } from "../contexts/SpaceContext";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  importFilesToSpace,
  isImportableSpaceFile,
  NoImportablePagesError,
  type ImportToSpaceResult,
} from "@/lib/spaceImport";

interface ImportAllDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SpaceOption {
  id: string;
  name: string;
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
  const [phase, setPhase] = useState<"select" | "importing" | "done">("select");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<ImportToSpaceResult | null>(null);
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
      isImportableSpaceFile,
    );
    if (dropped.length > 0) {
      setFiles(dropped);
      setError(null);
    } else {
      setError(
        t("import.pleaseSelectFiles", "Please select .zip, .md, or .txt files"),
      );
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

    try {
      const importResult = await importFilesToSpace(files, selectedSpaceId, {
        onProgress: setProgress,
        isAborted: () => abortRef.current,
      });

      if (!abortRef.current) {
        setResult(importResult);
        setPhase("done");
        // Invalidate page queries to refresh sidebar
        queryClient.invalidateQueries({ queryKey: ["pages"] });
      }
    } catch (err) {
      if (!abortRef.current) {
        setError(
          err instanceof NoImportablePagesError
            ? t(
                "import.noImportablePages",
                "No importable pages found in the ZIP file",
              )
            : err instanceof Error
              ? err.message
              : t("import.failed", "Import failed"),
        );
        setPhase("select");
      }
    }
  }, [files, selectedSpaceId, queryClient, t]);

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
              t(
                "import.fromZipOrMarkdownDesc",
                "Import pages from a ZIP file or markdown files.",
              )}
            {phase === "importing" &&
              t("import.importingPages", "Importing your pages...")}
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
                    : t("format.filesSelected", {
                        defaultValue: "{{count}} files selected",
                        count: files.length,
                      })}
                </span>
              ) : (
                <>
                  <span className="font-medium text-center">
                    {isDragging
                      ? t("import.dropFiles", "Drop files here")
                      : t(
                          "import.dragAndDropFiles",
                          "Drag and drop files here",
                        )}
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
                  <SelectValue
                    placeholder={t("space.selectSpace", "Select space")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {allSpaces.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {space.name || t("common.untitled", "Untitled")}
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
                  {t("import.importing", "Importing...")} {progress.done}/
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

        {phase === "done" && result && (
          <>
            <div className="space-y-3">
              <p className="text-sm">
                {t("common.created", "Created")} {result.pagesCreated}{" "}
                {result.pagesCreated === 1
                  ? t("common.pageKw", "page")
                  : t("common.pagesKw", "pages")}
                {result.imagesUploaded > 0 && (
                  <>
                    , {t("blocks.uploadedKw", "uploaded")}{" "}
                    {result.imagesUploaded}{" "}
                    {result.imagesUploaded === 1
                      ? t("blocks.imageKw", "image")
                      : t("blocks.imagesKw", "images")}
                  </>
                )}
              </p>
              {result.errors.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-destructive">
                    {result.errors.length}{" "}
                    {result.errors.length === 1
                      ? t("common.errorKw", "error")
                      : t("common.errorsKw", "errors")}
                    :
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
              <Button onClick={() => onOpenChange(false)}>
                {t("common.close", "Close")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
