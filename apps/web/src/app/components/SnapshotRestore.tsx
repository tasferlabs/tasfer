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

// Snapshot data type
interface Snapshot {
  id: string;
  createdAt: Date;
  blockCount: number;
  blocks: Block[]; // Actual block data for restoration
}

// Group snapshots by time intervals
interface SnapshotGroup {
  label: string;
  snapshots: Snapshot[];
}

function groupSnapshots(snapshots: Snapshot[]): SnapshotGroup[] {
  const now = new Date();
  const groups: Map<string, Snapshot[]> = new Map();

  // Define time boundaries
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  snapshots.forEach((snapshot) => {
    let groupKey: string;
    const date = snapshot.createdAt;

    if (date >= fiveMinutesAgo) {
      groupKey = "Last 5 minutes";
    } else if (date >= fifteenMinutesAgo) {
      groupKey = "Last 15 minutes";
    } else if (date >= oneHourAgo) {
      groupKey = "Last hour";
    } else if (date >= todayStart) {
      groupKey = "Earlier today";
    } else if (date >= yesterdayStart) {
      groupKey = "Yesterday";
    } else if (date >= weekAgo) {
      groupKey = "This week";
    } else {
      groupKey = "Older";
    }

    const existing = groups.get(groupKey) || [];
    existing.push(snapshot);
    groups.set(groupKey, existing);
  });

  // Convert to array with proper ordering
  const orderedLabels = [
    "Last 5 minutes",
    "Last 15 minutes",
    "Last hour",
    "Earlier today",
    "Yesterday",
    "This week",
    "Older",
  ];

  return orderedLabels
    .filter((label) => groups.has(label))
    .map((label) => ({
      label,
      snapshots: groups.get(label)!,
    }));
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
          <RelativeDate
            date={snapshot.createdAt}
            className="text-sm font-medium truncate block"
          />
          <p className="text-xs text-muted-foreground">
            {snapshot.blockCount}{" "}
            {snapshot.blockCount === 1 ? t`block` : t`blocks`}
          </p>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onPreview(snapshot)}
        className="text-muted-foreground hover:text-foreground shrink-0"
      >
        <EyeIcon className="h-3.5 w-3.5 mr-1.5" />
        {t`Preview`}
      </Button>
    </div>
  );
}

interface SnapshotRestoreContentProps {
  snapshots: Snapshot[];
  isLoading?: boolean;
  onPreview: (snapshot: Snapshot) => void;
}

function SnapshotRestoreContent({
  snapshots,
  isLoading,
  onPreview,
}: SnapshotRestoreContentProps) {
  const { t } = useTranslation();
  const groupedSnapshots = useMemo(
    () => groupSnapshots(snapshots),
    [snapshots]
  );

  // Get first group key for default expanded state
  const defaultExpanded = groupedSnapshots[0]?.label;

  const handlePreview = (snapshot: Snapshot) => {
    onPreview(snapshot);
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground mb-4" />
        <p className="text-muted-foreground">{t`Loading snapshots...`}</p>
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <History className="h-12 w-12 text-muted-foreground/50 mb-4" />
        <p className="text-muted-foreground">{t`No snapshots available`}</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          {t`Snapshots are created automatically as you edit`}
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
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
                      onPreview={handlePreview}
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
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const [previewingSnapshot, setPreviewingSnapshot] = useState<Snapshot | null>(
    null
  );
  const isMobile = useResponsive("(max-width: 768px)");

  // Use controlled state if provided, otherwise use internal state
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = onOpenChange || setInternalOpen;

  const { onRestoreSnapshot, pageId } = usePageSettings();
  const { getConfirmation } = useConfirmation();

  // Clear preview when closing
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setPreviewingSnapshot(null);
    }
    setOpen(newOpen);
  };

  // Fetch all snapshots from API (version history)
  const { data: snapshotsData, isLoading } = useGetPageSnapshots(
    open ? pageId ?? undefined : undefined
  );

  // Convert API snapshots to our Snapshot format
  const snapshots = useMemo<Snapshot[]>(() => {
    if (!snapshotsData || snapshotsData.length === 0) return [];

    return snapshotsData.map((s) => ({
      id: s.id,
      createdAt: new Date(s.createdAt),
      blockCount: s.blocks.filter((b) => !b.deleted).length,
      blocks: s.blocks,
    }));
  }, [snapshotsData]);

  const handleRestore = useCallback(
    async (snapshot: Snapshot) => {
      const confirmed = await getConfirmation({
        title: t`Restore this version?`,
        description: t`This will replace your current content with the selected snapshot. Any unsaved changes will be lost.`,
        cancelText: t`Cancel`,
        confirmText: t`Restore`,
      });

      if (!confirmed) return;

      // Call the restore function with the snapshot blocks
      if (onRestoreSnapshot && snapshot.blocks.length > 0) {
        onRestoreSnapshot(snapshot.blocks);
        setPreviewingSnapshot(null);
        setOpen(false);
      } else {
        console.warn("No restore function available or snapshot has no blocks");
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
          <DrawerContent className="max-h-[85vh]">
            <DrawerHeader>
              <DrawerTitle>{t`Version history`}</DrawerTitle>
              <DrawerDescription>
                {t`Restore a previous version of this page`}
              </DrawerDescription>
            </DrawerHeader>
            <SnapshotRestoreContent
              snapshots={snapshots}
              isLoading={isLoading}
              onPreview={handlePreview}
            />
            <DrawerFooter>
              <DrawerClose asChild>
                <Button variant="outline">{t`Cancel`}</Button>
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
        side="right"
        className="w-full sm:!max-w-xl md:!max-w-4xl lg:!max-w-5xl xl:!max-w-6xl flex flex-col"
      >
        <SheetHeader>
          <SheetTitle>{t`Version history`}</SheetTitle>
          <SheetDescription>
            {t`Restore a previous version of this page`}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 basis-full gap-4 overflow-hidden mt-4">
          {/* Snapshot list */}

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
                <p>{t`Select a snapshot to preview`}</p>
              </div>
            )}
          </div>
          <div className="w-80 shrink-0 border-l pr-4">
            <SnapshotRestoreContent
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
