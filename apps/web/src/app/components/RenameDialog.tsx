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
} from "@/components/ui/drawer";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { type CypherEditor, type Doc } from "@cypherkit/editor";
import { deriveTitles } from "@/lib/pageTitle";
import { useGetPage, useUpdatePage } from "../api/pages.api";
import { useActiveEditor } from "../contexts/ActiveEditorContext";
import { useCollaborativeDoc } from "../useCollaborativeDoc";
import { TitleEditor } from "../TitleEditor";
import useResponsive from "../hooks/useResponsive";

export interface RenameDialogProps {
  /** The page whose title is edited. */
  pageId?: string;
  /** Owning space, so a loaded (non-open) page's doc syncs on the right topic. */
  spaceId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Rename dialog built on {@link TitleEditor}. The title IS the document's first
 * heading, edited live through the CRDT — there is no separate "save".
 *
 * The dialog needs a live {@link Doc} for `pageId`. When `pageId` is the page
 * currently open in the editor, its doc is already live as the active editor's,
 * so we reuse it (no second room/persistence). Otherwise we spin up a short-lived
 * collaborative doc for the target page while the dialog is open, so any sidebar
 * page can be renamed with the same windowed title editor.
 */
export function RenameDialog({
  pageId,
  spaceId,
  open,
  onOpenChange,
}: RenameDialogProps) {
  const { id: routePageId } = useParams<{ id: string }>();
  const { editor } = useActiveEditor();
  // The active editor's runtime object is the `CypherEditor` (it carries the live
  // `doc`), though the context types it as the narrower `EditorApi` — hence the
  // localized cast.
  const activeDoc = (editor as CypherEditor | null)?.doc ?? null;

  // The page open in the editor: reuse its live doc directly. (`activeDoc` may be
  // briefly null while that editor mounts — the view then shows an empty title.)
  if (pageId && pageId === routePageId) {
    return (
      <RenameDialogView
        pageId={pageId}
        doc={activeDoc}
        open={open}
        onOpenChange={onOpenChange}
      />
    );
  }

  // A different page (or none): only load a live doc while the dialog is open, so
  // a closed dialog never joins a room or wires persistence for its page.
  if (!open || !pageId) {
    return (
      <RenameDialogView
        pageId={pageId ?? ""}
        doc={null}
        open={open}
        onOpenChange={onOpenChange}
      />
    );
  }

  return (
    <LoadedDocRename
      pageId={pageId}
      spaceId={spaceId}
      onOpenChange={onOpenChange}
    />
  );
}

/**
 * Load a not-currently-open page's snapshot, then mount its collaborative doc so
 * {@link TitleEditor} edits (and persists/syncs) the real heading. Split in two so
 * `useCollaborativeDoc` — which seeds the doc from the snapshot in the render
 * phase — only runs once the snapshot has loaded.
 */
function LoadedDocRename({
  pageId,
  spaceId,
  onOpenChange,
}: {
  pageId: string;
  spaceId?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: page } = useGetPage(pageId);

  if (!page) {
    return (
      <RenameDialogView
        pageId={pageId}
        doc={null}
        open
        onOpenChange={onOpenChange}
      />
    );
  }

  return (
    <LoadedDocRenameInner
      page={page}
      spaceId={spaceId}
      onOpenChange={onOpenChange}
    />
  );
}

function LoadedDocRenameInner({
  page,
  spaceId,
  onOpenChange,
}: {
  page: { id: string; blocks: unknown; spaceId?: string | null };
  spaceId?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const collab = useCollaborativeDoc({
    pageId: page.id,
    spaceId: spaceId ?? page.spaceId ?? undefined,
    snapshot: Array.isArray(page.blocks) ? page.blocks : [],
    readonly: false,
  });

  return (
    <RenameDialogView
      pageId={page.id}
      doc={collab.doc}
      open
      onOpenChange={onOpenChange}
    />
  );
}

/** Presentational shell + the derive-and-persist-on-close logic. */
function RenameDialogView({
  pageId,
  doc,
  open,
  onOpenChange,
}: {
  pageId: string;
  doc: Doc | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useResponsive("(max-width: 768px)");
  const { data: currentPage } = useGetPage(pageId || undefined);

  const { mutate: updatePage } = useUpdatePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["page", pageId] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  // TitleEditor edits the shared doc live, so the rename is already committed as
  // the user types. The body editor sees those edits as remote, so its own
  // local-save title derivation never runs — re-derive the denormalized
  // `page.title` record string (sidebar/chrome label) from the doc here on close
  // so it keeps mirroring the heading.
  const close = useCallback(() => {
    if (doc && pageId) {
      const { title, titleMd } = deriveTitles(doc.getRawBlocks());
      if (
        title !== (currentPage?.title ?? "") ||
        titleMd !== (currentPage?.titleMd ?? "")
      ) {
        updatePage({ id: pageId, title, titleMd });
      }
    }
    onOpenChange(false);
  }, [
    doc,
    pageId,
    currentPage?.title,
    currentPage?.titleMd,
    updatePage,
    onOpenChange,
  ]);

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
