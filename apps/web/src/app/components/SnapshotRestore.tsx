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
import { History, Clock, RotateCcw } from "lucide-react";
import { useState, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import useResponsive from "../hooks/useResponsive";
import { useConfirmation } from "./ConfirmationDialog";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { usePageSettings } from "../contexts/PageSettingsContext";
import { useGetPageSnapshots } from "../api/pages.api";
import type { Block } from "@/deserializer/loadPage";

// Initialize dayjs plugins
dayjs.extend(relativeTime);

// Snapshot data type
interface Snapshot {
  id: string;
  createdAt: Date;
  title: string;
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

function formatTime(date: Date): string {
  return dayjs(date).fromNow();
}

interface SnapshotItemProps {
  snapshot: Snapshot;
  onRestore: (snapshot: Snapshot) => void;
}

function SnapshotItem({ snapshot, onRestore }: SnapshotItemProps) {
  const { t } = useTranslation("SnapshotRestore");

  return (
    <div className="flex items-center justify-between py-2.5 px-1 group hover:bg-accent/50 rounded-md transition-colors">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{snapshot.title}</p>
          <p className="text-xs text-muted-foreground">
            {formatTime(snapshot.createdAt)} · {snapshot.blockCount}{" "}
            {snapshot.blockCount === 1 ? t`block` : t`blocks`}
          </p>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onRestore(snapshot)}
        className="text-muted-foreground hover:text-foreground shrink-0"
      >
        <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
        {t`Restore`}
      </Button>
    </div>
  );
}

interface SnapshotRestoreContentProps {
  snapshots: Snapshot[];
  isLoading?: boolean;
  onRestore: (snapshot: Snapshot) => void;
}

function SnapshotRestoreContent({
  snapshots,
  isLoading,
  onRestore,
}: SnapshotRestoreContentProps) {
  const { t } = useTranslation("SnapshotRestore");
  const groupedSnapshots = useMemo(
    () => groupSnapshots(snapshots),
    [snapshots]
  );

  // Get first group key for default expanded state
  const defaultExpanded = groupedSnapshots[0]?.label;

  const handleRestore = (snapshot: Snapshot) => {
    onRestore(snapshot);
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
                      onRestore={handleRestore}
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
  onRestore?: (snapshot: Snapshot) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SnapshotRestore({
  onRestore,
  open: controlledOpen,
  onOpenChange,
}: SnapshotRestoreProps) {
  const { t } = useTranslation("SnapshotRestore");
  const [internalOpen, setInternalOpen] = useState(false);
  const isMobile = useResponsive("(max-width: 768px)");

  // Use controlled state if provided, otherwise use internal state
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = onOpenChange || setInternalOpen;

  const { onRestoreSnapshot, pageId } = usePageSettings();
  const { getConfirmation } = useConfirmation();

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
      title: dayjs(s.createdAt).format("MMM D, YYYY h:mm A"),
      blockCount: s.blocks.filter((b) => !b.deleted).length,
      blocks: s.blocks,
    }));
  }, [snapshotsData]);

  const handleRestore = useCallback(async (snapshot: Snapshot) => {
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
      setOpen(false);
    } else {
      console.warn("No restore function available or snapshot has no blocks");
    }

    onRestore?.(snapshot);
  }, [getConfirmation, t, onRestoreSnapshot, setOpen, onRestore]);

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
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
            onRestore={handleRestore}
          />
          <DrawerFooter>
            <DrawerClose asChild>
              <Button variant="outline">{t`Cancel`}</Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg md:max-w-xl lg:max-w-2xl"
      >
        <SheetHeader>
          <SheetTitle>{t`Version history`}</SheetTitle>
          <SheetDescription>
            {t`Restore a previous version of this page`}
          </SheetDescription>
        </SheetHeader>
        <SnapshotRestoreContent
          snapshots={snapshots}
          isLoading={isLoading}
          onRestore={handleRestore}
        />
      </SheetContent>
    </Sheet>
  );
}

export type { Snapshot };
