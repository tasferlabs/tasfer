import DateTimePicker from "@/components/datetimepickers/DateTimePicker";
import { PagePicker } from "@/components/PagePicker";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Block } from "@/deserializer/loadPage";
import { extractTitleFromBlocks } from "@/editor/sync/char-runs";
import { DURATION_OPTIONS, formatDurationLabel } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  Calendar,
  CalendarDays,
  Clock,
  FolderOpen,
  GripHorizontal,
  Info,
  Maximize2,
  X
} from "lucide-react";
import { DateTime } from "luxon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  updatePage as updatePageApi,
  useGetPage,
  useMovePage,
  useUpdatePage,
  type HLC,
  type ISearchPage,
} from "../../api/pages.api";
import { useSidebarPanel } from "../../contexts/SidebarPanelContext";
import { useSpaces } from "../../contexts/SpaceContext";
import { useDebouncedSave } from "../../hooks/useDebouncedSave";
import useResponsive from "../../hooks/useResponsive";
import { MountedEditor } from "../../MountedEditor";
import type { DraftEvent } from "./CalendarPage";
import style from "./CalendarPage.module.css";

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 420;
const MIN_WIDTH = 300;
const MIN_HEIGHT = 300;
const GAP = 8;
const DRAG_OUT_BUFFER = 40;

function computePosition(
  anchor: DOMRect | null,
  width: number,
  height: number,
) {
  const maxH = window.innerHeight - 2 * GAP;
  const clampedH = Math.min(height, maxH);

  if (!anchor) {
    const clampedW = Math.min(width, window.innerWidth - 2 * GAP);
    return {
      top: Math.max(GAP, (window.innerHeight - clampedH) / 2),
      left: Math.max(GAP, (window.innerWidth - clampedW) / 2),
      width: clampedW,
      height: clampedH,
    };
  }

  let left: number;
  let top: number;
  let clampedW = width;

  // Available space on each side of the anchor
  const spaceRight = window.innerWidth - anchor.right - 2 * GAP;
  const spaceLeft = anchor.left - 2 * GAP;

  // Try right of event
  if (clampedW <= spaceRight) {
    left = anchor.right + GAP;
  }
  // Try left of event
  else if (clampedW <= spaceLeft) {
    left = anchor.left - GAP - clampedW;
  }
  // Pick the larger side and shrink to fit
  else if (spaceRight >= spaceLeft) {
    clampedW = Math.max(MIN_WIDTH, spaceRight);
    left = anchor.right + GAP;
  } else {
    clampedW = Math.max(MIN_WIDTH, spaceLeft);
    left = anchor.left - GAP - clampedW;
  }

  // Vertically center relative to anchor, clamped to viewport
  top = anchor.top + anchor.height / 2 - clampedH / 2;
  top = Math.max(GAP, Math.min(top, window.innerHeight - clampedH - GAP));

  return { top, left, width: clampedW, height: clampedH };
}

export function EventPreview({
  pageId,
  anchor,
  onClose,
  sidebarMode,
  onSidebarModeChange,
  draft,
  onDraftSave,
}: {
  pageId: string | null;
  anchor: DOMRect | null;
  onClose: () => void;
  sidebarMode: boolean;
  onSidebarModeChange: (mode: boolean) => void;
  draft?: DraftEvent | null;
  onDraftSave?: (
    snapshot?: Block[],
    clock?: HLC | null,
    parentId?: string | null,
    task?: boolean,
  ) => void;
}) {
  const { t } = useTranslation();
  const isMobile = useResponsive("(max-width: 768px)");
  const queryClient = useQueryClient();
  const popoverRef = useRef<HTMLDivElement>(null);
  const { panelRef, setHasPanel, slotMounted } = useSidebarPanel();
  const { activeSpaceId } = useSpaces();

  // Parent page selection
  const [draftParent, setDraftParent] = useState<ISearchPage | null>(null);
  const [draftIsTask, setDraftIsTask] = useState(true);

  // Remember the last user-resized dimensions across event switches
  const lastSizeRef = useRef({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });

  const [size, setSize] = useState({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startTop: number;
    startLeft: number;
  } | null>(null);
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    startTop: number;
    startLeft: number;
    mode: "both" | "x" | "y";
    invertX: boolean;
    invertY: boolean;
  } | null>(null);

  // Refs to avoid stale closures in pointer handlers
  const sidebarModeRef = useRef(sidebarMode);
  sidebarModeRef.current = sidebarMode;
  const onSidebarModeChangeRef = useRef(onSidebarModeChange);
  onSidebarModeChangeRef.current = onSidebarModeChange;
  const setHasPanelRef = useRef(setHasPanel);
  setHasPanelRef.current = setHasPanel;

  const [showSnapZone, setShowSnapZone] = useState(false);
  const [snapZoneWidth, setSnapZoneWidth] = useState(0);
  const snapZoneActiveRef = useRef(false);

  const isActive = !!(pageId || draft);

  // Sync hasPanel with sidebar mode, pageId, and whether the slot is mounted.
  // When sidebar closes (slotMounted=false), hasPanel clears so the sidebar
  // shows normal content. When it reopens, hasPanel is restored automatically.
  // When closing (isActive becomes false), delay clearing hasPanel so the exit
  // animation has time to play before the portal target unmounts.
  const hasPanelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (hasPanelTimerRef.current) {
      clearTimeout(hasPanelTimerRef.current);
      hasPanelTimerRef.current = null;
    }
    if (sidebarMode && isActive && slotMounted) {
      setHasPanel(true);
    } else if (!isActive && sidebarMode) {
      hasPanelTimerRef.current = setTimeout(() => setHasPanel(false), 250);
    } else {
      setHasPanel(false);
    }
  }, [sidebarMode, isActive, slotMounted, setHasPanel]);
  // Clean up timer and panel on unmount only
  useEffect(() => {
    return () => {
      if (hasPanelTimerRef.current) clearTimeout(hasPanelTimerRef.current);
      setHasPanel(false);
    };
  }, [setHasPanel]);

  // When opening a new preview, restore the last user-resized dimensions
  // but recompute position from anchor so the active event stays visible
  useEffect(() => {
    if (pageId || draft) {
      setSize({ ...lastSizeRef.current });
      setPos(null); // will be computed from anchor
      setDraftParent(null);
      setDraftIsTask(true);
    }
  }, [pageId, draft]);

  // Compute initial position from anchor (only when pos is null)
  const computed = useMemo(
    () => computePosition(anchor, size.width, size.height),
    [anchor, size],
  );
  const currentPos = pos ?? computed;
  // Use clamped size when position is anchor-computed (no manual pos yet)
  const currentSize = pos
    ? size
    : { width: computed.width, height: computed.height };

  // Drag + resize pointer handling (single effect)
  useEffect(() => {
    function handlePointerMove(e: PointerEvent) {
      if (dragRef.current) {
        const panelEl = panelRef.current;
        if (sidebarModeRef.current && panelEl) {
          // Sidebar mode: detect drag-out (drag RIGHT to detach from sidebar)
          const rect = panelEl.getBoundingClientRect();
          if (e.clientX > rect.right + DRAG_OUT_BUFFER) {
            // Switch to popover mode
            sidebarModeRef.current = false;
            onSidebarModeChangeRef.current(false);
            setHasPanelRef.current(false);
            const newTop = e.clientY - 20;
            const newLeft = e.clientX - DEFAULT_WIDTH / 2;
            setSize({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
            setPos({
              top: Math.max(GAP, newTop),
              left: Math.max(GAP, newLeft),
            });
            dragRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              startTop: newTop,
              startLeft: newLeft,
            };
          }
        } else {
          // Popover mode: update position + snap zone detection (LEFT edge)
          const dx = e.clientX - dragRef.current.startX;
          const dy = e.clientY - dragRef.current.startY;
          const el = popoverRef.current;
          const w = el?.offsetWidth ?? DEFAULT_WIDTH;
          const h = el?.offsetHeight ?? DEFAULT_HEIGHT;
          setPos({
            top: Math.max(
              GAP,
              Math.min(
                dragRef.current.startTop + dy,
                window.innerHeight - h - GAP,
              ),
            ),
            left: Math.max(
              GAP,
              Math.min(
                dragRef.current.startLeft + dx,
                window.innerWidth - w - GAP,
              ),
            ),
          });

          // Only allow snapping if sidebar panel slot exists (sidebar is open)
          // Use the sidebar container's actual bounds for snap detection
          const sidebarEl = panelRef.current?.closest(
            "[class*='appSidebar']",
          ) as HTMLElement | null;
          if (sidebarEl) {
            const sidebarRect = sidebarEl.getBoundingClientRect();
            const nearLeft = e.clientX < sidebarRect.right;
            snapZoneActiveRef.current = nearLeft;
            setShowSnapZone(nearLeft);
            if (nearLeft) setSnapZoneWidth(sidebarRect.right);
          } else {
            snapZoneActiveRef.current = false;
            setShowSnapZone(false);
          }
        }
      }
      if (resizeRef.current) {
        const {
          startX,
          startY,
          startW,
          startH,
          startTop,
          startLeft,
          mode,
          invertX,
          invertY,
        } = resizeRef.current;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let newW =
          mode === "y"
            ? startW
            : Math.max(MIN_WIDTH, startW + (invertX ? -1 : 1) * dx);
        let newH =
          mode === "x"
            ? startH
            : Math.max(MIN_HEIGHT, startH + (invertY ? -1 : 1) * dy);
        let newTop = invertY ? startTop + (startH - newH) : startTop;
        let newLeft = invertX ? startLeft + (startW - newW) : startLeft;
        // Clamp so the popover stays within the viewport
        if (newTop < GAP) {
          newH = newH + (newTop - GAP);
          newTop = GAP;
          if (newH < MIN_HEIGHT) newH = MIN_HEIGHT;
        }
        if (newLeft < GAP) {
          newW = newW + (newLeft - GAP);
          newLeft = GAP;
          if (newW < MIN_WIDTH) newW = MIN_WIDTH;
        }
        if (newTop + newH > window.innerHeight - GAP) {
          newH = window.innerHeight - GAP - newTop;
          if (newH < MIN_HEIGHT) newH = MIN_HEIGHT;
        }
        if (newLeft + newW > window.innerWidth - GAP) {
          newW = window.innerWidth - GAP - newLeft;
          if (newW < MIN_WIDTH) newW = MIN_WIDTH;
        }
        setSize({ width: newW, height: newH });
        lastSizeRef.current = { width: newW, height: newH };
        setPos({ top: newTop, left: newLeft });
      }
    }
    function handlePointerUp() {
      if (
        dragRef.current &&
        snapZoneActiveRef.current &&
        !sidebarModeRef.current
      ) {
        // Snap to sidebar
        sidebarModeRef.current = true;
        onSidebarModeChangeRef.current(true);
        setHasPanelRef.current(true);
      }
      snapZoneActiveRef.current = false;
      setShowSnapZone(false);
      dragRef.current = null;
      resizeRef.current = null;
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [panelRef]);

  const handleDragPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Don't drag if clicking a button or link inside the header
      if ((e.target as HTMLElement).closest("a, button")) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startTop: currentPos.top,
        startLeft: currentPos.left,
      };
    },
    [currentPos],
  );

  const handleResizePointerDown = useCallback(
    (
      e: React.PointerEvent,
      mode: "both" | "x" | "y" = "both",
      invertX = false,
      invertY = false,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setPos(currentPos);
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startW: size.width,
        startH: size.height,
        startTop: currentPos.top,
        startLeft: currentPos.left,
        mode,
        invertX,
        invertY,
      };
    },
    [size, currentPos],
  );

  const { data: previewPage, isLoading } = useGetPage(pageId || undefined);

  const { mutate: updatePage } = useUpdatePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["page", pageId] });
    },
  });

  const { mutate: movePage } = useMovePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["page", pageId] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  const isDraft = !!draft && !pageId;

  const handleTaskToggle = useCallback(() => {
    if (isDraft) {
      setDraftIsTask((v) => !v);
      return;
    }
    if (!pageId || !previewPage) return;
    updatePage({ id: pageId, task: !previewPage.task });
    // Optimistically update the cached page
    queryClient.setQueryData(["page", pageId], (old: any) =>
      old ? { ...old, task: !old.task } : old,
    );
    queryClient.invalidateQueries({ queryKey: ["pages"] });
  }, [isDraft, pageId, previewPage, updatePage, queryClient]);

  const handleParentChange = useCallback(
    (page: ISearchPage | null) => {
      if (isDraft) {
        setDraftParent(page);
        return;
      }
      if (!pageId) return;
      movePage({ id: pageId, parentId: page?.id ?? null });
    },
    [isDraft, pageId, movePage],
  );

  // Derive current parent for existing pages
  const currentParent: ISearchPage | null = isDraft
    ? draftParent
    : previewPage?.parentId
      ? {
          id: previewPage.parentId,
          title:
            previewPage.parents?.find((p) => p.id === previewPage.parentId)
              ?.title ?? null,
          parentId: null,
          path: null,
        }
      : null;

  // Close on click outside (disabled in sidebar mode)
  useEffect(() => {
    if (!isActive || sidebarMode) return;
    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        !(
          target instanceof Element &&
          target.closest(
            '[data-radix-popper-content-wrapper], [role="dialog"], [data-slot="combobox-content"]',
          )
        )
      ) {
        onClose();
      }
    }
    // Delay listener to avoid closing on the same click that opened it
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", handlePointerDown);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isActive, onClose, sidebarMode]);

  // Close on Escape
  useEffect(() => {
    if (!isActive) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive, onClose]);

  // Save edits from preview editor
  const handleSave = useCallback(
    async (data: { pageId: string; snapshot: Block[]; clock: HLC | null }) => {
      const title = extractTitleFromBlocks(data.snapshot);
      await updatePageApi({
        id: data.pageId,
        snapshot: data.snapshot,
        snapshotClock: data.clock,
        title,
      });
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
    [queryClient],
  );

  const { save: debouncedSave, flush } = useDebouncedSave(handleSave, 1000);

  // Store latest draft content so we can pass it when saving
  const draftContentRef = useRef<{
    snapshot: Block[];
    clock: HLC | null;
  } | null>(null);

  const handleContentChange = useCallback(
    (snapshot: Block[], clock: HLC | null) => {
      if (isDraft) {
        draftContentRef.current = { snapshot, clock };
        return;
      }
      if (!pageId) return;
      debouncedSave({ pageId, snapshot, clock });
    },
    [pageId, isDraft, debouncedSave],
  );

  const handleClose = useCallback(() => {
    flush();
    onClose();
  }, [flush, onClose]);

  const handleScheduleChange = useCallback(
    (scheduledAt: string, duration: number | null) => {
      if (!pageId) return;
      updatePage({ id: pageId, scheduledAt, duration });
    },
    [pageId, updatePage],
  );

  const isTask = isDraft ? draftIsTask : previewPage?.task;

  const taskEventRow = isDraft ? (
    <div className={style.previewRow}>
      <CalendarDays size={14} className={style.previewRowIcon} />

      <div className={style.previewTypeToggleGroup}>
        <button
          className={`${style.previewTypeToggleButton} ${draftIsTask ? style.previewTypeToggleActive : ""}`}
          onClick={() => setDraftIsTask(true)}
        >
          {t("Task")}
        </button>
        <button
          className={`${style.previewTypeToggleButton} ${!draftIsTask ? style.previewTypeToggleActive : ""}`}
          onClick={() => setDraftIsTask(false)}
        >
          {t("Event")}
        </button>
      </div>
    </div>
  ) : (
    <div className={style.previewRow}>
      <CalendarDays size={14} className={style.previewRowIcon} />

      <button
        className={style.previewTaskToggle}
        onClick={!isTask && previewPage?.hasChildren ? undefined : handleTaskToggle}
        disabled={!isTask && previewPage?.hasChildren}
      >
        {isTask ? t("Convert to Event") : t("Convert to Task")}
      </button>
      {!isTask && previewPage?.hasChildren && (
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger onClick={(e) => e.preventDefault()} asChild>
              <button type="button" className={style.previewTaskInfoIcon}>
                <Info size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {t("Move sub-pages to convert to task")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );

  const tz = DateTime.local().zoneName;
  const dateValue = isDraft
    ? (draft?.scheduledAt ?? null)
    : (previewPage?.scheduledAt ?? null);
  const currentDuration = isDraft
    ? (draft?.duration ?? 60)
    : (previewPage?.duration ?? 60);

  const durationLabels = useMemo(
    () => DURATION_OPTIONS.map((d) => formatDurationLabel(d, t)),
    [t],
  );

  const handleDateChange = (value: string | null) => {
    if (!value) return;
    if (isDraft) return; // Draft schedule is read-only until saved
    if (!previewPage?.scheduledAt) return;
    handleScheduleChange(value, previewPage.duration);
  };

  const handleDurationChange = (val: string) => {
    const idx = durationLabels.indexOf(val);
    if (idx === -1) return;
    if (isDraft) return; // Draft schedule is read-only until saved
    if (previewPage?.scheduledAt) {
      handleScheduleChange(previewPage.scheduledAt, DURATION_OPTIONS[idx]);
    }
  };

  const editorPadding = useMemo(
    () => ({
      paddingTop: 8,
      paddingBottom: 16,
      paddingLeft: 12,
      paddingRight: 12,
    }),
    [],
  );

  const editorBlockStyleOverrides = useMemo(
    () => ({
      heading1: { fontSize: 20, paddingBottom: 6 },
      heading2: { fontSize: 20, paddingBottom: 6 },
      heading3: { fontSize: 20, paddingBottom: 6 },
    }),
    [],
  );

  const draftSnapshot = useMemo<Block[]>(
    () => [{ id: "draft-1", type: "heading1", charRuns: [], formats: [] }],
    [],
  );

  const handleDraftSaveClick = useCallback(() => {
    const content = draftContentRef.current;
    onDraftSave?.(
      content?.snapshot,
      content?.clock,
      draftParent?.id ?? null,
      draftIsTask,
    );
  }, [onDraftSave, draftParent, draftIsTask]);

  const draftFooter = isDraft ? (
    <div className={style.previewDraftFooter}>
      <Button variant="ghost" size="sm" onClick={handleClose}>
        {t("Cancel")}
      </Button>
      <Button size="sm" onClick={handleDraftSaveClick}>
        {t("Save")}
      </Button>
    </div>
  ) : null;

  const editor = isDraft ? (
    <MountedEditor
      snapshot={draftSnapshot}
      pageId="__draft__"
      snapshotClock={null}
      onContentChange={handleContentChange}
      className="h-full"
      autoFocus
      padding={editorPadding}
      blockStyleOverrides={editorBlockStyleOverrides}
    />
  ) : isLoading ? (
    <div className={style.previewLoading}>{t("Loading...")}</div>
  ) : previewPage?.snapshot && pageId ? (
    <MountedEditor
      snapshot={previewPage.snapshot}
      pageId={pageId}
      snapshotClock={previewPage.snapshotClock}
      onContentChange={handleContentChange}
      className="h-full"
      autoFocus
      padding={editorPadding}
      blockStyleOverrides={editorBlockStyleOverrides}
    />
  ) : null;

  if (isMobile) {
    return (
      <Drawer
        open={isActive}
        onOpenChange={(open) => {
          if (!open) handleClose();
        }}
        modal={false}
      >
        <DrawerContent className="h-[90vh] flex flex-col p-0">
          <div className={style.previewPopoverHeader}>
            {pageId && (
              <Link to={`/page/${pageId}`} className={style.previewOpenLink}>
                <Maximize2 size={14} />
                {t("Open page")}
              </Link>
            )}
            <button className={style.previewCloseBtn} onClick={handleClose}>
              <X size={16} />
            </button>
          </div>
          <div className={style.previewRow}>
            <Calendar size={14} className={style.previewRowIcon} />
            <DateTimePicker
              type="datetime"
              value={dateValue}
              onChange={handleDateChange}
              timezone={tz}
              size="small"
              fullWidth
            />
          </div>
          <div className={style.previewRow}>
            <Clock size={14} className={style.previewRowIcon} />
            <Combobox
              items={durationLabels}
              value={formatDurationLabel(currentDuration, t)}
              onValueChange={(val) => {
                if (val != null) handleDurationChange(val);
              }}
            >
              <ComboboxInput
                placeholder={formatDurationLabel(currentDuration, t)}
                className={"w-full"}
              />
              <ComboboxContent>
                <ComboboxList>
                  {(item) => (
                    <ComboboxItem key={item} value={item}>
                      {item}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>
          <div className={style.previewRow}>
            <FolderOpen size={14} className={style.previewRowIcon} />
            <PagePicker
              spaceId={activeSpaceId}
              value={currentParent}
              onChange={handleParentChange}
              excludeId={pageId || undefined}
            />
          </div>
          {taskEventRow}
          <div className="flex-1 overflow-hidden border-t border-border">
            {editor}
          </div>
          {draftFooter}
        </DrawerContent>
      </Drawer>
    );
  }

  const scheduleRows = (
    <>
      <div className={style.previewRow}>
        <Calendar size={14} className={style.previewRowIcon} />
        <DateTimePicker
          type="datetime"
          value={dateValue}
          onChange={handleDateChange}
          timezone={tz}
          size="small"
          fullWidth
        />
      </div>
      <div className={style.previewRow}>
        <Clock size={14} className={style.previewRowIcon} />
        <Combobox
          items={durationLabels}
          value={formatDurationLabel(currentDuration, t)}
          onValueChange={(val) => {
            if (val != null) handleDurationChange(val);
          }}
        >
          <ComboboxInput
            placeholder={formatDurationLabel(currentDuration, t)}
            className={"w-full"}
          />
          <ComboboxContent>
            <ComboboxList>
              {(item) => (
                <ComboboxItem key={item} value={item}>
                  {item}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
      <div className={style.previewRow}>
        <FolderOpen size={14} className={style.previewRowIcon} />
        <PagePicker
          spaceId={activeSpaceId}
          value={currentParent}
          onChange={handleParentChange}
          excludeId={pageId || undefined}
        />
      </div>
      {taskEventRow}
      {pageId && (
        <div className={style.previewRow}>
          <Maximize2 size={14} className={style.previewRowIcon} />
          <Link to={`/page/${pageId}`} className={style.previewOpenLink}>
            {t("Open page")}
          </Link>
        </div>
      )}
    </>
  );

  // Sidebar mode - portal into the left sidebar
  if (sidebarMode && panelRef.current) {
    return createPortal(
      <AnimatePresence>
        {isActive && (
          <motion.div
            ref={popoverRef}
            className={style.previewSidebarContent}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div
              className={style.previewPopoverHeader}
              onPointerDown={handleDragPointerDown}
            >
              <GripHorizontal size={16} className={style.previewGripIcon} />
              <button className={style.previewCloseBtn} onClick={handleClose}>
                <X size={16} />
              </button>
            </div>
            {scheduleRows}
            <div className={style.previewEditorArea}>{editor}</div>
            {draftFooter}
          </motion.div>
        )}
      </AnimatePresence>,
      panelRef.current,
    );
  }

  // Popover mode
  return (
    <>
      {showSnapZone && (
        <div
          className={style.snapZoneIndicator}
          style={{ width: snapZoneWidth }}
        />
      )}
      <AnimatePresence>
        {isActive && (
          <motion.div
            ref={popoverRef}
            className={style.previewPopover}
            style={{
              top: currentPos.top,
              left: currentPos.left,
              width: currentSize.width,
              height: currentSize.height,
            }}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div
              className={style.previewPopoverHeader}
              onPointerDown={handleDragPointerDown}
            >
              <GripHorizontal size={16} className={style.previewGripIcon} />
              <button className={style.previewCloseBtn} onClick={handleClose}>
                <X size={16} />
              </button>
            </div>
            {scheduleRows}
            <div className={style.previewEditorArea}>{editor}</div>
            {draftFooter}
            <div
              className={style.previewCornerTL}
              onPointerDown={(e) =>
                handleResizePointerDown(e, "both", true, true)
              }
            />
            <div
              className={style.previewCornerTR}
              onPointerDown={(e) =>
                handleResizePointerDown(e, "both", false, true)
              }
            />
            <div
              className={style.previewCornerBL}
              onPointerDown={(e) => handleResizePointerDown(e, "both", true)}
            />
            <div
              className={style.previewCornerBR}
              onPointerDown={(e) => handleResizePointerDown(e, "both")}
            />
            <div
              className={style.previewResizeBarTop}
              onPointerDown={(e) =>
                handleResizePointerDown(e, "y", false, true)
              }
            />
            <div
              className={style.previewResizeBarBottom}
              onPointerDown={(e) => handleResizePointerDown(e, "y")}
            />
            <div
              className={style.previewResizeBarLeft}
              onPointerDown={(e) => handleResizePointerDown(e, "x", true)}
            />
            <div
              className={style.previewResizeBarRight}
              onPointerDown={(e) => handleResizePointerDown(e, "x")}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
