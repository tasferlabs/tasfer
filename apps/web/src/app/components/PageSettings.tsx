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
import { Input } from "@/components/ui/input";
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
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import {
  useDeletePage,
  useGetPage,
  useGetPages,
  useUpdatePage,
} from "../api/pages.api";
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
      title: t`Delete Page`,
      description: t`Are you sure you want to delete this page?`,
      cancelText: t`Cancel`,
      confirmText: t`Delete`,
    });

    if (confirmed && currentPageId) {
      deletePage({ id: currentPageId });
    }
  };

  const triggerButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground hover:text-foreground"
    >
      <MoreVertical className="h-4 w-4" />
      <span className="sr-only">{t`Page settings`}</span>
    </Button>
  );

  const fontOptions: Array<{
    value: FontStyle;
    label: string;
    className: string;
  }> = [
    { value: "default", label: t`Default`, className: "font-sans" },
    { value: "serif", label: t`Serif`, className: "font-serif" },
  ];

  const content = (
    <div className="flex-1 py-4">
      <div className="space-y-3 px-4 pb-8">
        <label className="text-sm font-medium sr-only">{t`Font style`}</label>
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

      <div className="space-y-3 py-6 border-t border-border px-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <label htmlFor="word-count-toggle" className="text-sm font-medium">
              {t`Show word count`}
            </label>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">
                {new Intl.NumberFormat(i18n.language).format(wordCount)}
              </span>{" "}
              {wordCount === 1 ? t`word` : t`words`}
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
            {t`Share`}
          </Button> */}
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground px-2 py-5"
            onClick={() => setShowRenameDialog(true)}
          >
            <Pencil className="h-4 w-4" />
            {t`Rename`}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-destructive hover:text-destructive px-2 py-5"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            <Trash2 className="h-4 w-4" />
            {t`Delete`}
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
          {t`Find in document`}
        </Button>
        {!isViewOnly && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground px-2 py-5"
            onClick={() => setShowImportDialog(true)}
          >
            <Replace className="h-4 w-4" />
            {t`Replace`}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground px-2 py-5"
          onClick={() => setShowExportDialog(true)}
        >
          <Download className="h-4 w-4" />
          {t`Export`}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground px-2 py-5"
          onClick={() => setShowVersionHistory(true)}
        >
          <History className="h-4 w-4" />
          {t`Version history`}
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{triggerButton}</DrawerTrigger>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm h-full  flex flex-col">
            <DrawerHeader className="relative">
              <DrawerTitle>{t`Page Settings`}</DrawerTitle>
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
          {t`Page Settings`}
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
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const { mutate: updatePage, isPending } = useUpdatePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["page", currentPageId] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      onOpenChange(false);
    },
  });

  useEffect(() => {
    if (open) {
      setRenameValue(currentPage?.title || "");
      // Focus input after dialog opens
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
    }
  }, [open, currentPage?.title]);

  const handleRename = () => {
    if (currentPageId && renameValue !== currentPage?.title) {
      updatePage({ id: currentPageId, title: renameValue, autoTitle: false });
    } else {
      onOpenChange(false);
    }
  };

  const content = (
    <div className="space-y-4">
      <Input
        ref={inputRef}
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleRename();
        }}
        placeholder={t`Page title`}
      />
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm pb-6">
            <DrawerHeader>
              <DrawerTitle>{t`Rename page`}</DrawerTitle>
            </DrawerHeader>
            <div className="px-4">{content}</div>
            <DrawerFooter className="pt-4">
              <Button onClick={handleRename} disabled={isPending}>
                {t`Save`}
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t`Cancel`}
              </Button>
            </DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Rename page`}</DialogTitle>
        </DialogHeader>
        {content}
        <DialogFooter>
          <Button onClick={handleRename} disabled={isPending}>
            {t`Save`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
