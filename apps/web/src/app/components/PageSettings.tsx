import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useQueryClient } from "@tanstack/react-query";
import {
  Download,
  History,
  MoreVertical,
  Pencil,
  Search,
  // Share2,
  Trash2,
  Replace,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { type CypherEditor } from "@cypherkit/editor";
import { extractTitleFromBlocks } from "@cypherkit/editor/internal";
import {
  useDeletePage,
  useGetPage,
  useGetPages,
  useUpdatePage,
} from "../api/pages.api";
import { useActiveEditor } from "../contexts/ActiveEditorContext";
import { TitleEditor } from "../TitleEditor";
import { useSpaces } from "../contexts/SpaceContext";
import {
  usePageSettings,
  type FontStyle,
} from "../contexts/PageSettingsContext";
import useResponsive from "../hooks/useResponsive";
import { useConfirmation } from "./ConfirmationDialog";
import { ExportDialog } from "./ExportDialog";
import { ImportDialog } from "./ImportDialog";
// import { ShareDialog } from "./ShareDialog";
import { SnapshotRestore } from "./SnapshotRestore";

export function PageSettings() {
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  // const [showShareDialog, setShowShareDialog] = useState(false);
  // const { id: pageId } = useParams<{ id: string }>();

  return (
    <>
      <PageSettingsImpl
        setShowVersionHistory={setShowVersionHistory}
        setShowExportDialog={setShowExportDialog}
        setShowImportDialog={setShowImportDialog}
        setShowRenameDialog={setShowRenameDialog}
        setShowShareDialog={() => {}}
      />
      <SnapshotRestore
        open={showVersionHistory}
        onOpenChange={setShowVersionHistory}
      />
      <ExportDialog
        open={showExportDialog}
        onOpenChange={setShowExportDialog}
      />
      <ImportDialog
        open={showImportDialog}
        onOpenChange={setShowImportDialog}
      />
      <RenameDialog
        open={showRenameDialog}
        onOpenChange={setShowRenameDialog}
      />
      {/* {pageId && (
        <ShareDialog
          pageId={pageId}
          open={showShareDialog}
          onOpenChange={setShowShareDialog}
        />
      )} */}
    </>
  );
}

function PageSettingsImpl({
  setShowVersionHistory,
  setShowExportDialog,
  setShowImportDialog,
  setShowRenameDialog,
  // setShowShareDialog,
}: {
  setShowVersionHistory: (open: boolean) => void;
  setShowExportDialog: (open: boolean) => void;
  setShowImportDialog: (open: boolean) => void;
  setShowRenameDialog: (open: boolean) => void;
  setShowShareDialog: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const {
    fontStyle,
    setFontStyle,
    editorWidth,
    setEditorWidth,
    showWordCount,
    setShowWordCount,
    wordCount,
    permission,
    onOpenFind,
  } = usePageSettings();
  const isViewOnly = permission === "view";
  const isMobile = useResponsive("(max-width: 768px)");

  // Page operations
  const { id: currentPageId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { getConfirmation } = useConfirmation();
  const { activeSpaceId } = useSpaces();
  const { data: rootPages } = useGetPages(activeSpaceId, null);

  const { mutate: deletePage, isPending: isDeleting } = useDeletePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      // Navigate to another page after deletion
      const remainingPages = rootPages?.filter(
        (page) => page.id !== currentPageId,
      );
      if (remainingPages && remainingPages.length > 0) {
        navigate(`/page/${remainingPages[0].id}`);
      } else {
        navigate("/page");
      }
      setOpen(false);
    },
  });

  const handleDelete = async () => {
    const confirmed = await getConfirmation({
      title: t("page.deletePage", "Delete Page"),
      description: t("page.confirmDeletePage", "Are you sure you want to delete this page?"),
      cancelText: t("common.cancel", "Cancel"),
      confirmText: t("common.delete", "Delete"),
    });

    if (confirmed && currentPageId) {
      deletePage({ id: currentPageId });
    }
  };

  // // Dev-only: force this page into the corrupted-recovery state by appending a
  // // block_delete for every visible block. The deletes are minted with counters
  // // strictly greater than the op-log frontier so they win the HLC sort and the
  // // rebuild yields zero visible blocks (the app's definition of "corrupted").
  // // Persisting to the op-log only takes effect on the next open, so we reload.
  // const handleCorruptPage = async () => {
  //   if (!currentPageId) return;
  //   const confirmed = await getConfirmation({
  //     title: t("dev.corruptPage", "Corrupt this page?"),
  //     description: t(
  //       "dev.corruptPageDescription",
  //       "Dev only: soft-deletes every block in this page's op-log so it rebuilds to the corrupted-recovery screen. The page then reloads.",
  //     ),
  //     cancelText: t("common.cancel", "Cancel"),
  //     confirmText: t("dev.corrupt", "Corrupt"),
  //   });
  //   if (!confirmed) return;

  //   const platform = getPlatform();
  //   const ops = await platform.ops.load(currentPageId);
  //   const maxCounter = ops.reduce((m, o) => Math.max(m, o.clock.counter), 0);
  //   const peerId = "__devcorrupt__";
  //   const deleteOps: Operation[] = currentBlocks
  //     .filter((b) => !b.deleted)
  //     .map((b, i) => {
  //       const counter = maxCounter + 1 + i;
  //       return {
  //         op: "block_delete",
  //         blockId: b.id,
  //         id: `${peerId}:${counter}`,
  //         clock: { counter, peerId },
  //         pageId: currentPageId,
  //       };
  //     });
  //   if (deleteOps.length === 0) return;

  //   await platform.ops.persist(currentPageId, deleteOps);
  //   window.location.reload();
  // };

  const triggerButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground hover:text-foreground"
    >
      <MoreVertical className="h-4 w-4" />
      <span className="sr-only">{t("page.settings", "Page settings")}</span>
    </Button>
  );

  const fontOptions: Array<{
    value: FontStyle;
    label: string;
    className: string;
  }> = [
    { value: "default", label: t("common.default", "Default"), className: "font-sans" },
    { value: "serif", label: t("settings.fontSerif", "Serif"), className: "font-serif" },
  ];

  const content = (
    <div className="flex-1 py-4">
      <div className="space-y-3 px-4 pb-8">
        <label className="text-sm font-medium sr-only">{t("settings.fontStyle", "Font style")}</label>
        <div className="grid grid-cols-2 gap-2">
          {fontOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setFontStyle(option.value)}
              className={`
                flex flex-col items-center justify-center
                p-2 rounded-lg border-2 transition-all
                hover:bg-accent duration-200 cursor-pointer
                ${
                  fontStyle === option.value
                    ? "border-primary"
                    : "border-border"
                }
              `}
            >
              <span
                className={`text-2xl font-medium mb-1 ${
                  fontStyle === option.value ? "text-primary" : ""
                } ${option.className}`}
              >
                Ag
              </span>
              <span className="text-xs text-muted-foreground">
                {option.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Full-width toggle is desktop/wide-device only: on mobile the column
          already fills the viewport, so there is no width to trade off. */}
      {!isMobile && (
        <div className="flex items-center justify-between px-4 pb-6">
          <label htmlFor="full-width-toggle" className="text-sm font-medium">
            {t("settings.fullWidth", "Full width")}
          </label>
          <Switch
            id="full-width-toggle"
            checked={editorWidth === "wide"}
            onCheckedChange={(checked) =>
              setEditorWidth(checked ? "wide" : "narrow")
            }
          />
        </div>
      )}

      <div className="space-y-3 py-6 border-t border-border px-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <label htmlFor="word-count-toggle" className="text-sm font-medium">
              {t("settings.showWordCount", "Show word count")}
            </label>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">
                {new Intl.NumberFormat(i18n.language).format(wordCount)}
              </span>{" "}
              {wordCount === 1 ? t("common.word", "word") : t("common.words", "words")}
            </p>
          </div>
          <Switch
            id="word-count-toggle"
            checked={showWordCount}
            onCheckedChange={setShowWordCount}
          />
        </div>
      </div>

      {!isViewOnly && (
        <div className="py-4 border-t border-border px-2">
          {/* <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground px-2 py-5"
            onClick={() => {
              setShowShareDialog(true);
              setOpen(false);
            }}
          >
            <Share2 className="h-4 w-4" />
            {t("common.share", "Share")}
          </Button> */}
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground px-2 py-5"
            onClick={() => setShowRenameDialog(true)}
          >
            <Pencil className="h-4 w-4" />
            {t("common.rename", "Rename")}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-destructive hover:text-destructive px-2 py-5"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            <Trash2 className="h-4 w-4" />
            {t("common.delete", "Delete")}
          </Button>
        </div>
      )}

      <div className="py-4 border-t border-border px-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground px-2 py-5"
          onClick={() => {
            onOpenFind?.();
            setOpen(false);
          }}
        >
          <Search className="h-4 w-4" />
          {t("editor.findInDocument", "Find in document")}
        </Button>
        {!isViewOnly && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground px-2 py-5"
            onClick={() => setShowImportDialog(true)}
          >
            <Replace className="h-4 w-4" />
            {t("common.replace", "Replace")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground px-2 py-5"
          onClick={() => setShowExportDialog(true)}
        >
          <Download className="h-4 w-4" />
          {t("export.title", "Export")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground px-2 py-5"
          onClick={() => setShowVersionHistory(true)}
        >
          <History className="h-4 w-4" />
          {t("snapshot.versionHistory", "Version history")}
        </Button>
      </div>

      {/* {devToolsEnabled && !isViewOnly && (
        <div className="py-4 border-t border-border px-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-destructive hover:text-destructive px-2 py-5"
            onClick={handleCorruptPage}
          >
            <Bug className="h-4 w-4" />
            {t("dev.corruptPageAction", "Corrupt this page")}
          </Button>
        </div>
      )} */}
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{triggerButton}</DrawerTrigger>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm h-full  flex flex-col">
            <DrawerHeader className="relative">
              <DrawerTitle>{t("page.settingsTitle", "Page Settings")}</DrawerTitle>
            </DrawerHeader>
            {content}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[280px] p-0 shadow-2xl">
        <DropdownMenuLabel className="sr-only">
          {t("page.settingsTitle", "Page Settings")}
        </DropdownMenuLabel>
        {content}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function RenameDialog({ open, onOpenChange }: RenameDialogProps) {
  const { t } = useTranslation();
  const { id: currentPageId } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { data: currentPage } = useGetPage(currentPageId);
  const isMobile = useResponsive("(max-width: 768px)");
  const { editor } = useActiveEditor();
  // The active editor's runtime object is the `CypherEditor` (it carries the
  // live `doc`), though the context types it as the narrower `EditorApi` — hence
  // the localized cast. `null` until the page's editor has mounted.
  const doc = (editor as CypherEditor | null)?.doc ?? null;

  const { mutate: updatePage } = useUpdatePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["page", currentPageId] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  // TitleEditor is a windowed view over the SAME shared doc the body renders, so
  // it edits the document's heading block live through the CRDT — the rename is
  // already committed (and synced/persisted) as the user types; there is no
  // separate "save" step. The body editor sees these edits as remote, so its own
  // local-save title derivation never runs. Re-derive the denormalized
  // `page.title` record string (sidebar/chrome label) from the doc here on close
  // so it keeps mirroring the heading.
  const close = useCallback(() => {
    if (doc && currentPageId) {
      const title = extractTitleFromBlocks(doc.getRawBlocks());
      if (title !== (currentPage?.title ?? "")) {
        updatePage({ id: currentPageId, title });
      }
    }
    onOpenChange(false);
  }, [doc, currentPageId, currentPage?.title, updatePage, onOpenChange]);

  // Route every dismissal (button, Escape, backdrop, swipe) through `close` so
  // the derived title is always persisted.
  const handleOpenChange = (next: boolean) =>
    next ? onOpenChange(true) : close();

  const content = doc ? (
    <TitleEditor
      doc={doc}
      editable
      autoFocus
      onSubmit={close}
      onCancel={close}
      placeholder={t("page.pageTitle", "Page title")}
    />
  ) : null;

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={handleOpenChange}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm pb-6">
            <DrawerHeader>
              <DrawerTitle>{t("page.renamePage", "Rename page")}</DrawerTitle>
            </DrawerHeader>
            <div className="px-4">{content}</div>
            <DrawerFooter className="pt-4">
              <Button onClick={close}>{t("common.done", "Done")}</Button>
            </DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("page.renamePage", "Rename page")}</DialogTitle>
        </DialogHeader>
        {content}
        <DialogFooter>
          <Button onClick={close}>{t("common.done", "Done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
