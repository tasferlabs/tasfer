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
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { History, Clock, Eye as EyeIcon, Eye } from "lucide-react";
import { useState, useMemo, useCallback } from "react";
import { RelativeDate } from "@/components/ui/relative-date";
import { useTranslation } from "react-i18next";
import useResponsive from "../hooks/useResponsive";
import { useConfirmation } from "./ConfirmationDialog";
import { usePageSettings } from "../contexts/PageSettingsContext";
import { useGetPageSnapshots } from "../api/pages.api";
import type { Block } from "@/deserializer/loadPage";
import { SnapshotPreview } from "./SnapshotPreview";

// Version data type (derived from ops, not stored snapshots)
interface Snapshot {
  id: string;
  versionNumber: number;
  opCount: number;
  blockCount: number;
  blocks: Block[];
  /** Wall-clock timestamp (ms). 0 if unknown (legacy ops). */
  createdAt: number;
}

// Group snapshots by time intervals
interface SnapshotGroup {
  label: string;
  snapshots: Snapshot[];
}

function groupSnapshots(snapshots: Snapshot[], t: (key: string, fallback: string) => string): SnapshotGroup[] {
  const now = new Date();
  const groups: Map<string, Snapshot[]> = new Map();

  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const labelKeys = [
    "snapshot.last5Minutes",
    "snapshot.last15Minutes",
    "snapshot.lastHour",
    "snapshot.earlierToday",
    "snapshot.yesterday",
    "snapshot.thisWeek",
    "snapshot.older",
  ];
  const labelFallbacks = [
    "Last 5 minutes",
    "Last 15 minutes",
    "Last hour",
    "Earlier today",
    "Yesterday",
    "This week",
    "Older",
  ];

  snapshots.forEach((snapshot) => {
    const date = new Date(snapshot.createdAt);
    let labelIndex: number;

    if (snapshot.createdAt <= 0) {
      labelIndex = 6; // Older
    } else if (date >= fiveMinutesAgo) {
      labelIndex = 0;
    } else if (date >= fifteenMinutesAgo) {
      labelIndex = 1;
    } else if (date >= oneHourAgo) {
      labelIndex = 2;
    } else if (date >= todayStart) {
      labelIndex = 3;
    } else if (date >= yesterdayStart) {
      labelIndex = 4;
    } else if (date >= weekAgo) {
      labelIndex = 5;
    } else {
      labelIndex = 6;
    }

    const key = labelKeys[labelIndex];
    const existing = groups.get(key) || [];
    existing.push(snapshot);
    groups.set(key, existing);
  });

  return labelKeys
    .filter((key) => groups.has(key))
    .map((key, _, _arr) => {
      const idx = labelKeys.indexOf(key);
      return {
        label: t(key, labelFallbacks[idx]),
        snapshots: groups.get(key)!,
      };
    });
}

interface SnapshotItemProps {
  snapshot: Snapshot;
  onPreview: (snapshot: Snapshot) => void;
}

function SnapshotItem({ snapshot, onPreview }: SnapshotItemProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between py-2.5 px-1 group hover:bg-accent/50 rounded-md transition-colors">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          {snapshot.createdAt > 0 ? (
            <RelativeDate
              date={new Date(snapshot.createdAt)}
              className="text-sm font-medium truncate block"
            />
          ) : (
            <p className="text-sm font-medium truncate">
              {t("common.version", "Version")} {snapshot.versionNumber}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {snapshot.blockCount}{" "}
            {snapshot.blockCount === 1 ? t("blocks.blockKw", "block") : t("blocks.blocksKw", "blocks")}
          </p>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onPreview(snapshot)}
        className="text-muted-foreground hover:text-foreground shrink-0"
      >
        <EyeIcon className="h-3.5 w-3.5 me-1.5" />
        {t("common.preview", "Preview")}
      </Button>
    </div>
  );
}

interface VersionListContentProps {
  snapshots: Snapshot[];
  isLoading?: boolean;
  onPreview: (snapshot: Snapshot) => void;
}

function VersionListContent({
  snapshots,
  isLoading,
  onPreview,
}: VersionListContentProps) {
  const { t } = useTranslation();
  const groupedSnapshots = useMemo(
    () => groupSnapshots(snapshots, t),
    [snapshots, t]
  );

  const defaultExpanded = groupedSnapshots[0]?.label;

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground mb-4" />
        <p className="text-muted-foreground">{t("snapshot.loading", "Loading versions...")}</p>
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <History className="h-12 w-12 text-muted-foreground/50 mb-4" />
        <p className="text-muted-foreground">{t("snapshot.noSnapshots", "No version history available")}</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          {t("snapshot.createdAutomatically", "Versions are derived from your edit history")}
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 overflow-hidden">
      <div className="p-4 pt-0">
        <Accordion
          type="single"
          collapsible
          defaultValue={defaultExpanded}
          className="w-full"
        >
          {groupedSnapshots.map((group) => (
            <AccordionItem key={group.label} value={group.label}>
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  {group.label}
                  <span className="text-xs text-muted-foreground font-normal">
                    ({group.snapshots.length})
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-0.5">
                  {group.snapshots.map((snapshot) => (
                    <SnapshotItem
                      key={snapshot.id}
                      snapshot={snapshot}
                      onPreview={onPreview}
                    />
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </ScrollArea>
  );
}

interface SnapshotRestoreProps {
  trigger?: React.ReactNode;
  onPreview?: (snapshot: Snapshot) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SnapshotRestore({
  onPreview,
  open: controlledOpen,
  onOpenChange,
}: SnapshotRestoreProps) {
  const { t, i18n } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const [previewingSnapshot, setPreviewingSnapshot] = useState<Snapshot | null>(
    null
  );
  const isMobile = useResponsive("(max-width: 768px)");
  const isRtl = i18n.dir() === "rtl";

  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = onOpenChange || setInternalOpen;

  const { onRestoreSnapshot, pageId } = usePageSettings();
  const { getConfirmation } = useConfirmation();

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setPreviewingSnapshot(null);
    }
    setOpen(newOpen);
  };

  // Fetch version history derived from ops
  const { data: snapshotsData, isLoading } = useGetPageSnapshots(
    open ? pageId ?? undefined : undefined
  );

  // Convert API data to our Snapshot format
  const snapshots = useMemo<Snapshot[]>(() => {
    if (!snapshotsData || snapshotsData.length === 0) return [];

    return snapshotsData.map((s, index) => ({
      id: s.id,
      versionNumber: snapshotsData.length - index,
      opCount: s.opCount,
      blockCount: s.blocks.filter((b) => !b.deleted).length,
      blocks: s.blocks,
      createdAt: s.createdAt,
    }));
  }, [snapshotsData]);

  const handleRestore = useCallback(
    async (snapshot: Snapshot) => {
      const confirmed = await getConfirmation({
        title: t("snapshot.restoreVersion", "Restore this version?"),
        description: t("snapshot.willReplace", "This will replace your current content with the selected version. This is done by appending new operations — nothing is lost."),
        cancelText: t("common.cancel", "Cancel"),
        confirmText: t("common.restore", "Restore"),
      });

      if (!confirmed) return;

      // Restore by appending CRDT operations (append-only, no data is lost)
      if (onRestoreSnapshot && snapshot.blocks.length > 0) {
        onRestoreSnapshot(snapshot.blocks);
        setPreviewingSnapshot(null);
        setOpen(false);
      }

      onPreview?.(snapshot);
    },
    [getConfirmation, t, onRestoreSnapshot, setOpen, onPreview]
  );

  const handleBackFromPreview = useCallback(() => {
    setPreviewingSnapshot(null);
  }, []);

  const handleRestoreFromPreview = useCallback(async () => {
    if (previewingSnapshot) {
      await handleRestore(previewingSnapshot);
    }
  }, [previewingSnapshot, handleRestore]);

  const handlePreview = useCallback((snapshot: Snapshot) => {
    setPreviewingSnapshot(snapshot);
  }, []);

  if (isMobile) {
    return (
      <>
        <Drawer open={open} onOpenChange={handleOpenChange}>
          <DrawerContent className="max-h-[85vh] flex flex-col">
            <DrawerHeader>
              <DrawerTitle>{t("snapshot.versionHistory", "Version history")}</DrawerTitle>
              <DrawerDescription>
                {t("snapshot.restorePrevious", "Restore a previous version of this page")}
              </DrawerDescription>
            </DrawerHeader>
            <div className="flex-1 min-h-0 overflow-hidden">
              <VersionListContent
                snapshots={snapshots}
                isLoading={isLoading}
                onPreview={handlePreview}
              />
            </div>
            <DrawerFooter>
              <DrawerClose asChild>
                <Button variant="outline">{t("common.cancel", "Cancel")}</Button>
              </DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>

        {/* Preview drawer for mobile */}
        <Drawer
          open={!!previewingSnapshot}
          onOpenChange={(open) => !open && setPreviewingSnapshot(null)}
        >
          <DrawerContent className="h-[95vh]">
            {previewingSnapshot && (
              <SnapshotPreview
                snapshot={previewingSnapshot}
                onBack={handleBackFromPreview}
                onRestore={handleRestoreFromPreview}
              />
            )}
          </DrawerContent>
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
          <SheetTitle>{t("snapshot.versionHistory", "Version history")}</SheetTitle>
          <SheetDescription>
            {t("snapshot.restorePrevious", "Restore a previous version of this page")}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 basis-full gap-4 overflow-hidden mt-4">
          {/* Preview area */}
          <div className="flex-1 overflow-hidden h-full">
            {previewingSnapshot ? (
              <SnapshotPreview
                snapshot={previewingSnapshot}
                onBack={handleBackFromPreview}
                onRestore={handleRestoreFromPreview}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                <Eye className="h-12 w-12 mb-4 opacity-50" />
                <p>{t("snapshot.selectToPreview", "Select a version to preview")}</p>
              </div>
            )}
          </div>
          {/* Version list */}
          <div className="w-80 shrink-0 border-s pe-4 flex flex-col h-full overflow-hidden">
            <VersionListContent
              snapshots={snapshots}
              isLoading={isLoading}
              onPreview={handlePreview}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export type { Snapshot };
