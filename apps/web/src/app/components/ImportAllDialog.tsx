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
import { ChevronRight, Upload } from "lucide-react";
import { useSpaces } from "../contexts/SpaceContext";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ISearchPage } from "../api/pages.api";
import { TitlePreview } from "../TitlePreview";
import { PagePicker } from "@/components/PagePicker";
import type { ImportParent } from "./ImportDialogProvider";
import {
  importFilesToSpace,
  isImportableSpaceFile,
  NoImportablePagesError,
  type ImportToSpaceResult,
} from "@/lib/spaceImport";

interface ImportAllDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * When set, imports go to this space and the space selector is hidden.
   * When omitted, the user picks the target space.
   */
  spaceId?: string;
  /**
   * When set, imported pages nest under this page and the parent picker is
   * hidden. When omitted, the user picks a parent (or top level).
   */
  parent?: ImportParent | null;
}

interface SpaceOption {
  id: string;
  name: string;
}

export function ImportAllDialog({
  open,
  onOpenChange,
  spaceId,
  parent,
}: ImportAllDialogProps) {
  const { t } = useTranslation();
  const { spaces } = useSpaces();
  const queryClient = useQueryClient();

  const allSpaces: SpaceOption[] = React.useMemo(() => {
    return spaces.map((s) => ({ id: s.id, name: s.name }));
  }, [spaces]);

  // A caller-supplied space/parent fixes that target and hides its control.
  const spaceFixed = spaceId != null;
  const parentFixed = parent != null;

  const [selectedSpaceId, setSelectedSpaceId] = useState<string>("");
  // Chosen parent page when the picker is shown; null means top level.
  const [selectedParent, setSelectedParent] = useState<ISearchPage | null>(
    null,
  );
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
      setSelectedSpaceId(spaceId || allSpaces[0]?.id || "");
      setSelectedParent(null);
      setFiles([]);
      setPhase("select");
      setProgress({ done: 0, total: 0 });
      setResult(null);
      setError(null);
      setIsDragging(false);
      abortRef.current = false;
    }
  }, [open, allSpaces, spaceId]);

  // A parent belongs to one space; switching space resets it to top level.
  const handleSpaceChange = useCallback((id: string) => {
    setSelectedSpaceId(id);
    setSelectedParent(null);
  }, []);

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
        parentId: parentFixed ? parent.id : (selectedParent?.id ?? null),
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
  }, [
    files,
    selectedSpaceId,
    parentFixed,
    parent,
    selectedParent,
    queryClient,
    t,
  ]);

  const handleCancel = useCallback(() => {
    if (phase === "importing") {
      abortRef.current = true;
    }
    onOpenChange(false);
  }, [phase, onOpenChange]);

  // When a target is fixed we hide its selector, so show where imports land.
  const targetSpaceName =
    allSpaces.find((s) => s.id === selectedSpaceId)?.name ||
    t("common.untitled", "Untitled");

  // Pluralised on their own so the summary sentence stays a single translatable
  // unit; languages with dual/few/many forms need the noun phrase, not a numeral
  // glued to a bare plural.
  const pagesPhrase = t("import.pagesCount", {
    count: result?.pagesCreated ?? 0,
    defaultValue_one: "{{count, number}} page",
    defaultValue_other: "{{count, number}} pages",
  });
  const imagesPhrase = t("import.imagesCount", {
    count: result?.imagesUploaded ?? 0,
    defaultValue_one: "{{count, number}} image",
    defaultValue_other: "{{count, number}} images",
  });

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
              data-file-drop-scope="local"
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

            {/* Confirm the destination when a selector is hidden (fixed target). */}
            {(spaceFixed || parentFixed) && (
              <div className="flex items-center gap-2 text-sm">
                <span className="whitespace-nowrap text-muted-foreground">
                  {t("import.importingTo", "Importing to")}
                </span>
                <span className="flex min-w-0 items-center gap-1 font-medium">
                  <span className="truncate">{targetSpaceName}</span>
                  {parentFixed && (
                    <>
                      <ChevronRight
                        size={14}
                        className="shrink-0 text-muted-foreground rtl:rotate-180"
                      />
                      <span className="truncate">
                        <TitlePreview
                          title={parent.title}
                          titleMd={parent.titleMd}
                        />
                      </span>
                    </>
                  )}
                </span>
              </div>
            )}

            {/* Space selector — hidden when the caller fixed the target space. */}
            {!spaceFixed && (
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  {t("import.to", "Import to")}
                </span>
                <Select
                  value={selectedSpaceId}
                  onValueChange={handleSpaceChange}
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
            )}

            {/* Parent picker — hidden when the caller fixed the parent page. */}
            {!parentFixed && (
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  {t("import.under", "Import under")}
                </span>
                <PagePicker
                  spaceId={selectedSpaceId || null}
                  value={selectedParent}
                  onChange={setSelectedParent}
                  showNoneOption
                  className="flex-1"
                />
              </div>
            )}

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
                {result.imagesUploaded > 0
                  ? t("import.doneSummaryWithImages", {
                      defaultValue: "Created {{pages}}, uploaded {{images}}",
                      pages: pagesPhrase,
                      images: imagesPhrase,
                    })
                  : t("import.doneSummary", {
                      defaultValue: "Created {{pages}}",
                      pages: pagesPhrase,
                    })}
              </p>
              {result.errors.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-destructive">
                    {t("import.errorsCount", {
                      count: result.errors.length,
                      defaultValue_one: "{{count, number}} error:",
                      defaultValue_other: "{{count, number}} errors:",
                    })}
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
