import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
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
  FolderInput,
  History,
  MoreVertical,
  Pencil,
  Search,
  // Share2,
  Archive,
  Replace,
} from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { lazy, Suspense, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useDeletePage, useGetPage, useGetPages } from "../api/pages.api";
import { MovePageDialog } from "./MovePageDialog";
import { RenameDialog } from "./RenameDialog";
import { useSpaces } from "../contexts/SpaceContext";
import {
  usePageSettings,
  type FontStyle,
} from "../contexts/PageSettingsContext";
import useMobileLayout from "../hooks/useMobileLayout";
import { useConfirmation } from "./ConfirmationDialog";
// import { ShareDialog } from "./ShareDialog";

/** Matches the sidebar's resize curve so panel motion stays consistent. */
const MENU_EASE = [0.32, 0.72, 0, 1] as const;

/** Each group of the menu settles in just behind the one above it. */
const SECTION_VARIANTS = {
  hidden: { opacity: 0, y: -4 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, ease: MENU_EASE },
  },
};

const SECTION_LIST_VARIANTS = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.025, delayChildren: 0.02 } },
};

const ExportDialog = lazy(() =>
  import("./ExportDialog").then((module) => ({ default: module.ExportDialog })),
);
const ImportDialog = lazy(() =>
  import("./ImportDialog").then((module) => ({ default: module.ImportDialog })),
);
const SnapshotRestore = lazy(() =>
  import("./SnapshotRestore").then((module) => ({
    default: module.SnapshotRestore,
  })),
);

export function PageSettings() {
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  // const [showShareDialog, setShowShareDialog] = useState(false);
  const { id: pageId } = useParams<{ id: string }>();
  const { data: page } = useGetPage(pageId);

  return (
    <>
      <PageSettingsImpl
        setShowVersionHistory={setShowVersionHistory}
        setShowExportDialog={setShowExportDialog}
        setShowImportDialog={setShowImportDialog}
        setShowRenameDialog={setShowRenameDialog}
        setShowMoveDialog={setShowMoveDialog}
        setShowShareDialog={() => {}}
      />
      <Suspense fallback={null}>
        {showVersionHistory && (
          <SnapshotRestore open onOpenChange={setShowVersionHistory} />
        )}
        {showExportDialog && (
          <ExportDialog open onOpenChange={setShowExportDialog} />
        )}
        {showImportDialog && (
          <ImportDialog open onOpenChange={setShowImportDialog} />
        )}
      </Suspense>
      <RenameDialog
        pageId={pageId}
        open={showRenameDialog}
        onOpenChange={setShowRenameDialog}
      />
      {pageId && page?.spaceId && (
        <MovePageDialog
          pages={[{ id: pageId, parentId: page.parentId }]}
          sourceSpaceId={page.spaceId}
          open={showMoveDialog}
          onOpenChange={setShowMoveDialog}
        />
      )}
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
  setShowMoveDialog,
  // setShowShareDialog,
}: {
  setShowVersionHistory: (open: boolean) => void;
  setShowExportDialog: (open: boolean) => void;
  setShowImportDialog: (open: boolean) => void;
  setShowRenameDialog: (open: boolean) => void;
  setShowMoveDialog: (open: boolean) => void;
  setShowShareDialog: (open: boolean) => void;
}) {
  const { t } = useTranslation();
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
  const { isMobile } = useMobileLayout();
  const reduceMotion = useReducedMotion();
  // Scoped per instance: a module-level id would let two mounted menus share
  // one highlight and animate it between them.
  const fontHighlightId = useId();

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
      title: t("page.archivePage", "Archive Page"),
      description: t(
        "page.confirmArchivePage",
        "Archiving deletes nothing. This page and its subpages move to the Archive, where you can restore them anytime.",
      ),
      cancelText: t("common.cancel", "Cancel"),
      confirmText: t("common.archive", "Archive"),
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
    {
      value: "default",
      label: t("common.default", "Default"),
      className: "font-sans",
    },
    {
      value: "serif",
      label: t("settings.fontSerif", "Serif"),
      className: "font-serif",
    },
  ];

  const content = (
    <motion.div
      className="flex-1 py-4"
      // The drawer's own slide already carries the motion on mobile, so the
      // stagger is desktop-only.
      initial={isMobile || reduceMotion ? false : "hidden"}
      animate="visible"
      variants={SECTION_LIST_VARIANTS}
    >
      <motion.div variants={SECTION_VARIANTS} className="space-y-3 px-4 pb-8">
        <label className="text-sm font-medium sr-only">
          {t("settings.fontStyle", "Font style")}
        </label>
        <div className="grid grid-cols-2 gap-2">
          {fontOptions.map((option) => (
            <motion.button
              key={option.value}
              onClick={() => setFontStyle(option.value)}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className={`
                relative flex flex-col items-center justify-center
                p-2 rounded-lg border-2 border-border transition-colors
                hover:bg-accent duration-200 cursor-pointer
              `}
            >
              {/* The selected outline is one element that slides between the
                  cards, so picking a font reads as a move rather than two
                  independent repaints. Offset by the 2px border it covers. */}
              {fontStyle === option.value && (
                <motion.span
                  layoutId={`${fontHighlightId}-font-selection`}
                  className="absolute -inset-0.5 rounded-lg border-2 border-primary pointer-events-none"
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { duration: 0.2, ease: MENU_EASE }
                  }
                />
              )}
              <span
                className={`text-2xl font-medium mb-1 transition-colors ${
                  fontStyle === option.value ? "text-primary" : ""
                } ${option.className}`}
              >
                Ag
              </span>
              <span className="text-xs text-muted-foreground">
                {option.label}
              </span>
            </motion.button>
          ))}
        </div>
      </motion.div>

      {/* Full-width toggle is desktop/wide-device only: on mobile the column
          already fills the viewport, so there is no width to trade off. */}
      {!isMobile && (
        <motion.div
          variants={SECTION_VARIANTS}
          className="flex items-center justify-between px-4 pb-6"
        >
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
        </motion.div>
      )}

      <motion.div
        variants={SECTION_VARIANTS}
        className="space-y-3 py-6 border-t border-border px-4"
      >
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <label htmlFor="word-count-toggle" className="text-sm font-medium">
              {t("settings.showWordCount", "Show word count")}
            </label>
            <p className="text-xs text-muted-foreground">
              {t("common.wordCount", {
                count: wordCount,
                defaultValue_one: "{{count, number}} word",
                defaultValue_other: "{{count, number}} words",
              })}
            </p>
          </div>
          <Switch
            id="word-count-toggle"
            checked={showWordCount}
            onCheckedChange={setShowWordCount}
          />
        </div>
      </motion.div>

      {!isViewOnly && (
        <motion.div
          variants={SECTION_VARIANTS}
          className="py-4 border-t border-border px-2"
        >
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
            className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground px-2 py-5"
            onClick={() => {
              setShowMoveDialog(true);
              setOpen(false);
            }}
          >
            <FolderInput className="h-4 w-4" />
            {t("page.movePage", "Move page")}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 px-2 py-5"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            <Archive className="h-4 w-4" />
            {t("common.archive", "Archive")}
          </Button>
        </motion.div>
      )}

      <motion.div
        variants={SECTION_VARIANTS}
        className="py-4 border-t border-border px-2"
      >
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
      </motion.div>

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
    </motion.div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{triggerButton}</DrawerTrigger>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm h-full  flex flex-col">
            <DrawerHeader className="relative">
              <DrawerTitle>
                {t("page.settingsTitle", "Page Settings")}
              </DrawerTitle>
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
