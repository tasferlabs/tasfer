import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
  DrawerClose,
} from "@/components/ui/drawer";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Eye,
  FilePlus2,
  History,
  Paintbrush,
  PencilLine,
  Plus,
  RefreshCw,
  Replace,
  Trash2,
} from "lucide-react";
import { useState, useMemo, useCallback } from "react";
import { RelativeDate } from "@/components/ui/relative-date";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { formatDatePreferred } from "@/lib/dateTimePreferences";
import { cn } from "@/lib/utils";
import useMobileLayout from "../hooks/useMobileLayout";
import { useConfirmation } from "./ConfirmationDialog";
import { usePageSettings } from "../contexts/PageSettingsContext";
import { useAuth } from "../contexts/AuthContext";
import {
  useCreatePage,
  useGetPageVersions,
  useVersionBlocks,
  type IVersion,
} from "../api/pages.api";
import { useGetSpaceMembers } from "../api/spaces.api";
import { useSpaces } from "../contexts/SpaceContext";
import { getPlatform } from "@/platform";
import { extractTitleFromBlocks } from "@tasfer/editor/internal";
import { SnapshotPreview } from "./SnapshotPreview";
import { versionCharDelta, versionLabel } from "./versionLabel";

/**
 * Radix wraps a ScrollArea's children in a `display: table` div, which sizes to
 * its widest child rather than to the column. Left alone, a row's `w-full`
 * resolves against that expanded width, so a long label pushes the row past the
 * panel instead of truncating inside it. The app sidebar overrides the same
 * quirk in its CSS module (Layout.module.css).
 *
 * Radix's own `min-width: 100%` on that div is left alone — as a block it means
 * "fill the viewport", which is what a short list wants.
 */
const SCROLL_VIEWPORT_BLOCK = "[&_[data-radix-scroll-area-viewport]>div]:!block";

const KIND_ICON = {
  created: FilePlus2,
  replaced: Replace,
  deletion: Trash2,
  addition: Plus,
  rewrite: RefreshCw,
  formatting: Paintbrush,
  edit: PencilLine,
} as const;

/**
 * Maps the CRDT peer ids on a version entry to the person who was editing.
 * A peer id is a device public key, and one human owns several devices, so the
 * lookup goes through the space roster rather than naming the device.
 */
function useVersionAuthors(spaceId: string | null) {
  const { user } = useAuth();
  const { data: people } = useGetSpaceMembers(spaceId ?? undefined);

  return useMemo(() => {
    const byDevice = new Map<string, string>();
    for (const person of people ?? []) {
      for (const device of person.devices) {
        byDevice.set(device.id, person.userName);
      }
    }
    return {
      selfKey: user?.id ?? null,
      nameFor: (peerId: string) => byDevice.get(peerId) ?? null,
    };
  }, [people, user?.id]);
}

interface VersionRowProps {
  version: IVersion;
  selected: boolean;
  authorName: string | null;
  onSelect: (version: IVersion) => void;
}

function VersionRow({
  version,
  selected,
  authorName,
  onSelect,
}: VersionRowProps) {
  const { t } = useTranslation();
  const Icon = KIND_ICON[version.kind] ?? PencilLine;
  const delta = versionCharDelta(version, t);
  const label = versionLabel(version, t);

  return (
    <button
      type="button"
      onClick={() => onSelect(version)}
      aria-current={selected}
      className={cn(
        "w-full min-w-0 text-start flex items-start gap-3 rounded-md px-2 py-2.5 transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 mt-0.5 shrink-0",
          version.kind === "deletion"
            ? "text-destructive"
            : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1">
        {/* A label naming a heading can outrun the column; the row shows what
            fits and the title carries the rest. */}
        <span className="block text-sm font-medium truncate" title={label}>
          {label}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {version.createdAt > 0 && (
            <RelativeDate date={new Date(version.createdAt)} />
          )}
          {delta && <span className="tabular-nums">{delta}</span>}
          {authorName && <span className="truncate">{authorName}</span>}
        </span>
      </span>
    </button>
  );
}

interface VersionListProps {
  versions: IVersion[];
  isLoading?: boolean;
  selectedId?: string;
  spaceId: string | null;
  onSelect: (version: IVersion) => void;
}

function VersionList({
  versions,
  isLoading,
  selectedId,
  spaceId,
  onSelect,
}: VersionListProps) {
  const { t } = useTranslation();
  const { selfKey, nameFor } = useVersionAuthors(spaceId);

  // A date heading only where the day actually turns over — the list is short
  // enough now that bucketing it into "last 5 minutes / last hour / earlier"
  // would split a handful of rows across more headings than rows.
  const rows = useMemo(() => {
    let lastDay: string | null = null;
    return versions.map((version) => {
      const day =
        version.createdAt > 0
          ? new Date(version.createdAt).toDateString()
          : null;
      const heading = day !== null && day !== lastDay ? version.createdAt : null;
      if (day !== null) lastDay = day;

      // Name the author only when it wasn't just this device: on a page nobody
      // else has touched, repeating the owner's name on every row is noise.
      const others = version.peerIds.filter((id) => id !== selfKey);
      const authorName = others.length > 0 ? nameFor(others[0]) : null;

      return { version, heading, authorName };
    });
  }, [versions, selfKey, nameFor]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground mb-4" />
        <p className="text-muted-foreground">
          {t("snapshot.loading", "Loading versions...")}
        </p>
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <History className="h-12 w-12 text-muted-foreground/50 mb-4" />
        <p className="text-muted-foreground">
          {t("snapshot.noSnapshots", "No version history available")}
        </p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          {t(
            "snapshot.createdAutomatically",
            "Versions are derived from your edit history",
          )}
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className={cn("flex-1 overflow-hidden", SCROLL_VIEWPORT_BLOCK)}>
      <div className="min-w-0 p-4 pt-0 space-y-0.5">
        {rows.map(({ version, heading, authorName }) => (
          <div key={version.id}>
            {heading !== null && (
              <p className="px-2 pt-4 pb-1 text-xs font-medium text-muted-foreground">
                {formatDatePreferred(new Date(heading), {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            )}
            <VersionRow
              version={version}
              selected={version.id === selectedId}
              authorName={authorName}
              onSelect={onSelect}
            />
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

interface SnapshotRestoreProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Restrict recovery to forking. Used from the corrupted-page screen, where
   * restoring in place cannot recover the page — the persisted op-log rebuilds
   * to the same broken state — so Fork (a clean new page) is the only option.
   */
  forkOnly?: boolean;
}

export function SnapshotRestore({
  open: controlledOpen,
  onOpenChange,
  forkOnly,
}: SnapshotRestoreProps) {
  const { t, i18n } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const [selected, setSelected] = useState<IVersion | null>(null);
  const { isMobile } = useMobileLayout();
  const isRtl = i18n.dir() === "rtl";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = onOpenChange || setInternalOpen;

  const { onRestoreSnapshot, pageId } = usePageSettings();
  const { activeSpaceId } = useSpaces();
  const { getConfirmation } = useConfirmation();
  const { mutateAsync: createPage, isPending: isForking } = useCreatePage();

  const { data: versions, isLoading } = useGetPageVersions(
    open ? (pageId ?? undefined) : undefined,
  );

  // Content is built for the one entry the user opened, not for all of them.
  const { data: selectedBlocks, isLoading: isLoadingBlocks } = useVersionBlocks(
    pageId ?? undefined,
    selected?.id,
  );

  // The entry this one followed. The list runs newest-first, so the version
  // before the selected one sits *after* it.
  const previousVersionId = useMemo(() => {
    if (!versions || !selected) return undefined;
    const index = versions.findIndex((v) => v.id === selected.id);
    return index >= 0 ? versions[index + 1]?.id : undefined;
  }, [versions, selected]);

  // Fetched so the preview can point at what this version changed instead of
  // leaving the reader to spot the difference.
  const { data: previousBlocks } = useVersionBlocks(
    pageId ?? undefined,
    previousVersionId,
  );

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) setSelected(null);
    setOpen(newOpen);
  };

  const handleRestore = useCallback(async () => {
    if (!selectedBlocks || selectedBlocks.length === 0) return;

    const confirmed = await getConfirmation({
      title: t("snapshot.restoreVersion", "Restore this version?"),
      description: t(
        "snapshot.willReplace",
        "This will replace your current content with the selected version. This is done by appending new operations — nothing is lost.",
      ),
      cancelText: t("common.cancel", "Cancel"),
      confirmText: t("common.restore", "Restore"),
    });

    if (!confirmed) return;

    // Restore by appending CRDT operations (append-only, no data is lost)
    onRestoreSnapshot?.(selectedBlocks);
    setSelected(null);
    setOpen(false);
  }, [selectedBlocks, getConfirmation, t, onRestoreSnapshot, setOpen]);

  const handleFork = useCallback(async () => {
    if (!activeSpaceId || !selectedBlocks || selectedBlocks.length === 0) return;

    const titleFromSnapshot = extractTitleFromBlocks(selectedBlocks);
    const sourceTitle = titleFromSnapshot || t("common.version", "Version");
    const forkTitle = t("snapshot.forkTitle", "{{title}} fork", {
      title: sourceTitle,
    });

    const forkedPage = await createPage({
      title: forkTitle,
      parentId: null,
      spaceId: activeSpaceId,
    });

    const platform = getPlatform();
    // Persist the forked content as ops; the first page open rebuilds the
    // blocks from them and writes a snapshot whose version-vector token
    // matches. Pre-saving a snapshot here would have no matching token (the
    // ops' clocks are minted inside writeBlocks), so it would be discarded on
    // open anyway.
    await platform.ops.writeBlocks(forkedPage.id, selectedBlocks);

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["pages"] }),
      queryClient.invalidateQueries({ queryKey: ["page", forkedPage.id] }),
    ]);

    setSelected(null);
    setOpen(false);
    navigate(`/page/${forkedPage.id}`);
  }, [
    activeSpaceId,
    selectedBlocks,
    createPage,
    navigate,
    queryClient,
    setOpen,
    t,
  ]);

  const handleBack = useCallback(() => setSelected(null), []);

  const list = (
    <VersionList
      versions={versions ?? []}
      isLoading={isLoading}
      selectedId={selected?.id}
      spaceId={activeSpaceId}
      onSelect={setSelected}
    />
  );

  const preview = selected ? (
    <SnapshotPreview
      version={selected}
      blocks={selectedBlocks ?? null}
      previousBlocks={previousBlocks ?? null}
      isLoading={isLoadingBlocks}
      onBack={handleBack}
      onRestore={handleRestore}
      onFork={handleFork}
      isForking={isForking}
      forkOnly={forkOnly}
    />
  ) : null;

  const description = forkOnly
    ? t("snapshot.forkPrevious", "Fork a previous version into a new page")
    : t("snapshot.restorePrevious", "Restore a previous version of this page");

  if (isMobile) {
    return (
      <>
        <Drawer open={open} onOpenChange={handleOpenChange}>
          <DrawerContent className="desktop:max-h-[85vh] flex flex-col">
            <DrawerHeader className="shrink-0">
              <DrawerTitle>
                {t("snapshot.versionHistory", "Version history")}
              </DrawerTitle>
              <DrawerDescription>{description}</DrawerDescription>
            </DrawerHeader>
            {/* The ScrollArea sizes off its parent, so the parent has to be a
                column flex box with a real height — otherwise the list grows to
                its content and gets clipped by the drawer with no scrollbar. */}
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
              {list}
            </div>
            <DrawerFooter className="shrink-0">
              <DrawerClose asChild>
                <Button variant="outline">{t("common.cancel", "Cancel")}</Button>
              </DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>

        <Drawer
          open={!!selected}
          onOpenChange={(next) => !next && setSelected(null)}
        >
          <DrawerContent className="desktop:h-[95vh]">{preview}</DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side={isRtl ? "left" : "right"}
        className="w-full sm:!max-w-xl md:!max-w-4xl lg:!max-w-5xl xl:!max-w-6xl flex flex-col"
      >
        <SheetHeader>
          <SheetTitle>
            {t("snapshot.versionHistory", "Version history")}
          </SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 basis-full gap-4 overflow-hidden mt-4">
          <div className="flex-1 overflow-hidden h-full">
            {preview ?? (
              <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                <Eye className="h-12 w-12 mb-4 opacity-50" />
                <p>{t("snapshot.selectToPreview", "Select a version to preview")}</p>
              </div>
            )}
          </div>
          <div className="w-80 shrink-0 border-s pe-4 flex flex-col h-full overflow-hidden">
            {list}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
