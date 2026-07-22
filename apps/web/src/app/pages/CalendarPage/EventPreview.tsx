import DateTimePicker from "@/components/datetimepickers/DateTimePicker";
import { PagePicker } from "@/components/PagePicker";
import { useConfirmation } from "@/app/components/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { createDoc, type Block, type Doc } from "@tasfer/editor";
import {
  cleanSnapshotForSave,
  extractTitleFromBlocks,
} from "@tasfer/editor/internal";
import { deriveTitles } from "@/lib/pageTitle";
import { getResolvedTimezone } from "@/lib/dateTimePreferences";
import { DURATION_OPTIONS, formatDurationLabel } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  Calendar,
  CalendarDays,
  Box,
  ChevronDown,
  Clock,
  Copy,
  FolderOpen,
  GripHorizontal,
  Info,
  Maximize2,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { DateTime } from "luxon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import { Link } from "react-router-dom";
import {
  useDeletePage,
  updatePage as updatePageApi,
  useGetPage,
  useMovePage,
  useUpdatePage,
  type ISearchPage,
} from "../../api/pages.api";
import { useSidebarPanel } from "../../contexts/SidebarPanelContext";
import { useSpaces } from "../../contexts/SpaceContext";
import { useDebouncedSave } from "../../hooks/useDebouncedSave";
import useResponsive from "../../hooks/useResponsive";
import { MountedEditor } from "../../MountedEditor";
import { TitleEditor } from "../../TitleEditor";
import { appSchema } from "../../../editorSchema";
import { DraftParentSearch, DraftTagPicker } from "./DraftTagPicker";
import type { DraftEvent } from "./CalendarPage";
import style from "./CalendarPage.module.css";

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 420;
const MIN_WIDTH = 300;
const MIN_HEIGHT = 300;
const GAP = 8;
const POPOVER_AUTO_TOP_GAP = 72;
const DRAG_OUT_BUFFER = 40;

function clampPopoverTop(top: number, height: number, topGap = GAP) {
  const maxTop = window.innerHeight - height - GAP;
  const minTop = Math.min(topGap, Math.max(GAP, maxTop));
  return Math.max(minTop, Math.min(top, Math.max(minTop, maxTop)));
}

function computePosition(
  anchor: DOMRect | null,
  width: number,
  height: number,
) {
  const maxH = window.innerHeight - POPOVER_AUTO_TOP_GAP - GAP;
  const clampedH = Math.min(height, maxH);
  const isRtl = i18next.dir() === "rtl";

  if (!anchor) {
    const clampedW = Math.min(width, window.innerWidth - 2 * GAP);
    return {
      top: clampPopoverTop(
        (window.innerHeight - clampedH) / 2,
        clampedH,
        POPOVER_AUTO_TOP_GAP,
      ),
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

  // In RTL, prefer placing the popover to the left (inline-start) of the anchor
  const spaceInlineEnd = isRtl ? spaceLeft : spaceRight;
  const spaceInlineStart = isRtl ? spaceRight : spaceLeft;

  // Try inline-end of event first
  if (clampedW <= spaceInlineEnd) {
    left = isRtl ? anchor.left - GAP - clampedW : anchor.right + GAP;
  }
  // Try inline-start of event
  else if (clampedW <= spaceInlineStart) {
    left = isRtl ? anchor.right + GAP : anchor.left - GAP - clampedW;
  }
  // Pick the larger side and shrink to fit if MIN_WIDTH fits
  else if (spaceInlineEnd >= MIN_WIDTH || spaceInlineStart >= MIN_WIDTH) {
    if (spaceInlineEnd >= spaceInlineStart) {
      clampedW = Math.max(MIN_WIDTH, spaceInlineEnd);
      left = isRtl ? anchor.left - GAP - clampedW : anchor.right + GAP;
    } else {
      clampedW = Math.max(MIN_WIDTH, spaceInlineStart);
      left = isRtl ? anchor.right + GAP : anchor.left - GAP - clampedW;
    }
  }
  // Neither side fits MIN_WIDTH — position above or below the anchor instead
  else {
    clampedW = Math.min(width, window.innerWidth - 2 * GAP);
    left = isRtl ? window.innerWidth - GAP - clampedW : GAP;

    const spaceBelow = window.innerHeight - anchor.bottom - GAP;
    const spaceAbove = anchor.top - GAP;

    if (spaceBelow >= clampedH) {
      top = anchor.bottom + GAP;
    } else if (spaceAbove >= clampedH) {
      top = anchor.top - GAP - clampedH;
    } else {
      // Not enough room above or below either — center in viewport
      top = clampPopoverTop(
        (window.innerHeight - clampedH) / 2,
        clampedH,
        POPOVER_AUTO_TOP_GAP,
      );
      left = Math.max(GAP, (window.innerWidth - clampedW) / 2);
    }

    top ??= 0;
    top = clampPopoverTop(top, clampedH, POPOVER_AUTO_TOP_GAP);
    return { top, left, width: clampedW, height: clampedH };
  }

  // Vertically center relative to anchor, clamped to viewport
  top = anchor.top + anchor.height / 2 - clampedH / 2;
  top = clampPopoverTop(top, clampedH, POPOVER_AUTO_TOP_GAP);

  return { top, left, width: clampedW, height: clampedH };
}

export function EventPreview({
  pageId,
  anchor,
  onClose,
  sidebarMode,
  onSidebarModeChange,
  onDuplicate,
  draft,
  onDraftSave,
  onDraftScheduleChange,
  onDraftContentChange,
}: {
  pageId: string | null;
  anchor: DOMRect | null;
  onClose: () => void;
  sidebarMode: boolean;
  onSidebarModeChange: (mode: boolean) => void;
  // Duplicate the currently-previewed event into a new page and select it.
  onDuplicate?: (pageId: string) => void;
  draft?: DraftEvent | null;
  onDraftSave?: (
    blocks?: Block[],
    clock?: unknown,
    parentId?: string | null,
    task?: boolean,
    spaceId?: string,
  ) => void;
  // Draft schedule edits flow up so the grid's `__draft__` card stays in sync
  // with the sheet's date/duration fields (two-way with grid drag/resize).
  onDraftScheduleChange?: (scheduledAt: string, duration: number) => void;
  // Reports whether the draft has a typed title, so the host can guard
  // navigation away from an in-progress draft.
  onDraftContentChange?: (hasContent: boolean) => void;
}) {
  const { t } = useTranslation();
  const isRtl = i18next.dir() === "rtl";
  const isMobile = useResponsive("(max-width: 768px)");
  // const isFinePointer = useResponsive("(pointer: fine)");
  const queryClient = useQueryClient();
  const popoverRef = useRef<HTMLDivElement>(null);
  const { panelRef, setHasPanel, slotMounted } = useSidebarPanel();
  const { activeSpaceId, spaces } = useSpaces();
  const { getConfirmation } = useConfirmation();

  // Parent page selection
  const [draftParent, setDraftParent] = useState<ISearchPage | null>(null);
  const [draftIsTask, setDraftIsTask] = useState(true);
  const [draftSpaceId, setDraftSpaceId] = useState<string | null>(
    activeSpaceId,
  );
  // Desktop draft parent picker: search mode swaps in for the drill-down rows.
  const [parentSearchOpen, setParentSearchOpen] = useState(false);

  // Mobile drawer: the schedule fields (date, duration, space, type) collapse
  // into a single summary line and expand on tap. Collapsed by default so the
  // title editor leads; reset whenever a different preview opens.
  const [detailsOpen, setDetailsOpen] = useState(false);

  // The draft edits a lightweight, local-only CRDT doc through the compact
  // TitleEditor (a single-heading window) instead of mounting the full page
  // editor for what is only an event title. Created when a draft opens and
  // destroyed on close; existing events still use the full MountedEditor.
  const [draftDoc, setDraftDoc] = useState<Doc | null>(null);

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
  // but recompute position from anchor so the active event stays visible.
  // Keyed on draft *presence*, not the draft object: editing the draft's
  // schedule mints a new draft object every change, and re-running this would
  // wipe the space picker / collapse the details mid-edit.
  const draftActive = !!draft;
  useEffect(() => {
    if (pageId || draftActive) {
      setSize({ ...lastSizeRef.current });
      setPos(null); // will be computed from anchor
      setDraftParent(null);
      setDraftIsTask(true);
      setDraftSpaceId(activeSpaceId);
      setParentSearchOpen(false);
      setDetailsOpen(false);
    }
  }, [pageId, draftActive, activeSpaceId]);

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
        const isRtl = i18next.dir() === "rtl";
        if (sidebarModeRef.current && panelEl) {
          // Sidebar mode: detect drag-out (drag away from sidebar edge to detach)
          const rect = panelEl.getBoundingClientRect();
          const draggedOut = isRtl
            ? e.clientX < rect.left - DRAG_OUT_BUFFER
            : e.clientX > rect.right + DRAG_OUT_BUFFER;
          if (draggedOut) {
            // Switch to popover mode
            sidebarModeRef.current = false;
            onSidebarModeChangeRef.current(false);
            setHasPanelRef.current(false);
            const newTop = e.clientY - 20;
            const newLeft = e.clientX - DEFAULT_WIDTH / 2;
            setSize({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
            setPos({
              top: clampPopoverTop(newTop, DEFAULT_HEIGHT),
              left: Math.max(GAP, newLeft),
            });
            dragRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              startTop: clampPopoverTop(newTop, DEFAULT_HEIGHT),
              startLeft: newLeft,
            };
          }
        } else {
          // Popover mode: update position + snap zone detection (sidebar edge)
          const dx = e.clientX - dragRef.current.startX;
          const dy = e.clientY - dragRef.current.startY;
          const el = popoverRef.current;
          const w = el?.offsetWidth ?? DEFAULT_WIDTH;
          const h = el?.offsetHeight ?? DEFAULT_HEIGHT;
          setPos({
            top: clampPopoverTop(dragRef.current.startTop + dy, h),
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
            const nearSidebar = isRtl
              ? e.clientX > sidebarRect.left
              : e.clientX < sidebarRect.right;
            snapZoneActiveRef.current = nearSidebar;
            setShowSnapZone(nearSidebar);
            if (nearSidebar) {
              setSnapZoneWidth(
                isRtl
                  ? window.innerWidth - sidebarRect.left
                  : sidebarRect.right,
              );
            }
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
        const minTop = Math.min(
          GAP,
          Math.max(GAP, window.innerHeight - MIN_HEIGHT - GAP),
        );
        if (newTop < minTop) {
          newH = newH + (newTop - minTop);
          newTop = minTop;
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

  // Stabilize the snapshot so the editor doesn't remount on every react-query
  // refetch. The editor manages its own state via CRDT ops after the initial
  // mount — we only need the snapshot once per pageId.
  const [pageSnapshot, setPageSnapshot] = useState<Block[] | null>(null);
  const snapshotPageIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (pageId !== snapshotPageIdRef.current) {
      snapshotPageIdRef.current = pageId;
      setPageSnapshot(null);
    }
  }, [pageId]);

  useEffect(() => {
    if (
      previewPage?.blocks &&
      snapshotPageIdRef.current === pageId &&
      !pageSnapshot
    ) {
      setPageSnapshot(previewPage.blocks);
    }
  }, [previewPage?.blocks, pageId, pageSnapshot]);

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
  const draftTargetSpaceId = draftSpaceId ?? activeSpaceId;

  const handleDraftSpaceChange = useCallback((spaceId: string) => {
    setDraftSpaceId(spaceId);
    // Parent pages cannot cross space boundaries.
    setDraftParent(null);
    setParentSearchOpen(false);
  }, []);

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
  const parentSegment = previewPage?.parents?.find(
    (p) => p.id === previewPage.parentId,
  );
  const currentParent: ISearchPage | null = isDraft
    ? draftParent
    : previewPage?.parentId
      ? {
          id: previewPage.parentId,
          title: parentSegment?.title ?? null,
          titleMd: parentSegment?.titleMd ?? null,
          parentId: null,
          path: null,
        }
      : null;

  // Close on click outside (popover mode only).
  // Listens in the CAPTURE phase: when a modal Radix layer (date picker,
  // timezone picker, combobox, ...) is dismissed by an outside pointerdown,
  // Radix closes it synchronously (flushSync) from a document-level listener
  // and restores <body>'s pointer-events before the event would reach a
  // bubble listener. Capture runs first, while <body> still has
  // pointer-events: none, so the dismissing click is reliably attributed to
  // the modal layer instead of closing this popover too.
  useEffect(() => {
    if (!isActive || sidebarMode || isMobile) return;
    function handlePointerDown(e: PointerEvent) {
      // A modal Radix layer is open; this click belongs to that layer.
      if (document.body.style.pointerEvents === "none") return;
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest(
          '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [data-slot="combobox-content"]',
        )
      ) {
        return;
      }
      onClose();
    }
    // Delay listener to avoid closing on the same click that opened it
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", handlePointerDown, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isActive, onClose, sidebarMode, isMobile]);

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
    async (data: { pageId: string; blocks: Block[] }) => {
      await updatePageApi({
        id: data.pageId,
        ...deriveTitles(data.blocks),
      });
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
    [queryClient],
  );

  const { save: debouncedSave, flush } = useDebouncedSave(handleSave, 1000);

  // Store latest draft content so we can pass it when saving
  const draftContentRef = useRef<{
    blocks: Block[];
  } | null>(null);

  const handleContentChange = useCallback(
    (blocks: Block[]) => {
      if (isDraft) {
        draftContentRef.current = { blocks };
        onDraftContentChange?.(
          extractTitleFromBlocks(blocks).trim().length > 0,
        );
        return;
      }
      if (!pageId) return;
      debouncedSave({ pageId, blocks });
    },
    [pageId, isDraft, debouncedSave, onDraftContentChange],
  );

  // Create the draft's doc during the render that opens it (render-phase state
  // adjustment) rather than in an effect: an effect-created doc mounted the
  // TitleEditor one commit after the sheet, so the title field popped in and
  // the editor's synchronous canvas mount hitched the entrance animation.
  // `createDoc` is pure construction (no external registration), so it is safe
  // to call while rendering.
  if (draftActive && !draftDoc) {
    setDraftDoc(
      createDoc({
        blocks: [
          { id: "draft-1", type: "heading1", charRuns: [], formats: [] },
        ],
        pageId: "__draft__",
        peerId: "draft-local",
        schema: appSchema.data,
      }),
    );
  }

  // Mirror every draft edit to the host (title presence + latest blocks for
  // save) while the draft is open, and destroy the doc when it closes.
  // `handleContentChange`'s draft branch stores the blocks and reports whether
  // a title has been typed — the same path the old editor used.
  useEffect(() => {
    if (!draftActive) {
      if (draftDoc) {
        draftDoc.destroy();
        setDraftDoc(null);
      }
      return;
    }
    if (!draftDoc) return;
    handleContentChange(cleanSnapshotForSave(draftDoc.getRawBlocks()));
    return draftDoc.on("update", () => {
      handleContentChange(cleanSnapshotForSave(draftDoc.getRawBlocks()));
    });
  }, [draftActive, draftDoc, handleContentChange]);

  // The cleanup above only unsubscribes, so destroy an open draft's doc if the
  // preview unmounts mid-draft. `destroy()` is idempotent, so racing the
  // close-path destroy is harmless.
  const draftDocRef = useRef<Doc | null>(null);
  draftDocRef.current = draftDoc;
  useEffect(() => () => draftDocRef.current?.destroy(), []);

  const handleClose = useCallback(() => {
    flush();
    onClose();
  }, [flush, onClose]);

  const { mutate: deletePage, isPending: isDeleting } = useDeletePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.removeQueries({ queryKey: ["page", pageId] });
      handleClose();
    },
  });

  const handleDelete = useCallback(async () => {
    if (!pageId || !previewPage || isDeleting) return;

    const confirmed = await getConfirmation({
      title: t("calendar.deleteEvent", "Delete event"),
      description: previewPage.hasChildren
        ? t(
            "calendar.eventHasSubPages",
            "This event has sub-pages. Deleting it will also delete its sub-pages.",
          )
        : t(
            "calendar.confirmDeleteEvent",
            "Are you sure you want to delete this event?",
          ),
      cancelText: t("common.cancel", "Cancel"),
      confirmText: t("common.delete", "Delete"),
    });
    if (!confirmed) return;

    deletePage({ id: pageId });
  }, [deletePage, getConfirmation, isDeleting, pageId, previewPage, t]);

  const handleDuplicate = useCallback(async () => {
    if (!pageId || !onDuplicate) return;
    // Persist any pending debounced edits so the copy reflects the latest
    // content rather than the last-saved snapshot.
    await flush();
    onDuplicate(pageId);
  }, [flush, onDuplicate, pageId]);

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
          {t("calendar.task", "Task")}
        </button>
        <button
          className={`${style.previewTypeToggleButton} ${!draftIsTask ? style.previewTypeToggleActive : ""}`}
          onClick={() => setDraftIsTask(false)}
        >
          {t("calendar.event", "Event")}
        </button>
      </div>
    </div>
  ) : (
    <div className={style.previewRow}>
      <CalendarDays size={14} className={style.previewRowIcon} />

      <button
        className={style.previewTaskToggle}
        onClick={
          !isTask && previewPage?.hasChildren ? undefined : handleTaskToggle
        }
        disabled={!isTask && previewPage?.hasChildren}
      >
        {isTask
          ? t("calendar.convertToEvent", "Convert to Event")
          : t("calendar.convertToTask", "Convert to Task")}
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
              {t(
                "calendar.moveSubPagesToConvert",
                "Move sub-pages to convert to task",
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );

  // Display time zone from Settings: the stored instant is unchanged, it is
  // just displayed and edited in the preferred zone.
  const tz = getResolvedTimezone();
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
    if (isDraft) {
      onDraftScheduleChange?.(value, currentDuration);
      return;
    }
    if (!previewPage?.scheduledAt) return;
    handleScheduleChange(value, previewPage.duration || null);
  };

  const handleDurationChange = (val: string) => {
    const idx = durationLabels.indexOf(val);
    if (idx === -1) return;
    if (isDraft) {
      if (dateValue) onDraftScheduleChange?.(dateValue, DURATION_OPTIONS[idx]);
      return;
    }
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
      // Compact preview: opt out of the page theme's prose space-above-headings
      // (paddingTop) — this surface is deliberately tight, and heading1 is the
      // event title sitting at the very top.
      heading1: { fontSize: 20, paddingTop: 0, paddingBottom: 6 },
      heading2: { fontSize: 20, paddingTop: 0, paddingBottom: 6 },
      heading3: { fontSize: 20, paddingTop: 0, paddingBottom: 6 },
    }),
    [],
  );

  const previewPlaceholderOverrides = useMemo(
    () => ({
      heading1: { text: t("common.title", "Title") },
    }),
    [t],
  );

  const handleDraftSaveClick = useCallback(() => {
    const content = draftContentRef.current;
    if (!draftTargetSpaceId) return;
    onDraftSave?.(
      content?.blocks,
      null,
      draftParent?.id ?? null,
      draftIsTask,
      draftTargetSpaceId,
    );
  }, [onDraftSave, draftParent, draftIsTask, draftTargetSpaceId]);

  // Desktop: Ctrl/Cmd+Enter saves a draft. Existing events already autosave, so
  // there is nothing to commit for them. Capture phase so the shortcut wins over
  // the editor's own Enter handling. Mobile drives saving from the footer button.
  useEffect(() => {
    if (!isActive || isMobile || !isDraft) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      handleDraftSaveClick();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isActive, isMobile, isDraft, handleDraftSaveClick]);

  const draftFooter = isDraft ? (
    <div className={style.previewDraftFooter}>
      <Button variant="ghost" size="sm" onClick={handleClose}>
        {t("common.cancel", "Cancel")}
      </Button>
      <Button size="sm" onClick={handleDraftSaveClick}>
        {t("common.save", "Save")}
      </Button>
    </div>
  ) : null;

  const editor = isDraft ? (
    // The compact title editor (a single-heading window over the draft doc)
    // renders as a fixed single-line field — a draft title is short, and a fixed
    // height keeps the sheet tight instead of reserving tall auto-grow space. On
    // mobile the sheet stays compact (a "peek") so the grid behind it is visible
    // and its handles remain draggable; auto-focusing would raise the keyboard and
    // expand the sheet over the grid, so defer focus until the user taps the
    // title. Desktop keeps immediate focus. Enter commits the draft (single-block
    // window makes Enter inert in the engine).
    draftDoc ? (
      // The gutter lives on a wrapper: TitleEditor draws the Input component's
      // border box, so padding inside it would inset the text from its own
      // border instead of insetting the field from the sheet edge.
      <div className="px-3">
        <TitleEditor
          doc={draftDoc}
          autoFocus={!isMobile}
          onSubmit={handleDraftSaveClick}
          placeholder={t("calendar.addTitle", "Add title")}
        />
      </div>
    ) : null
  ) : isLoading && !pageSnapshot ? (
    <div className={style.previewLoading}>
      {t("common.loading", "Loading...")}
    </div>
  ) : pageSnapshot && pageId ? (
    <MountedEditor
      key={pageId}
      snapshot={pageSnapshot}
      pageId={pageId}
      onContentChange={handleContentChange}
      className="h-full"
      autoFocus
      padding={editorPadding}
      blockStyleOverrides={editorBlockStyleOverrides}
      placeholderOverrides={previewPlaceholderOverrides}
    />
  ) : null;

  // One-line summary of the collapsed schedule fields for the mobile accordion.
  const summaryDate = dateValue
    ? DateTime.fromISO(dateValue, { zone: tz ?? undefined })
    : null;
  const scheduleSummary = {
    when:
      summaryDate && summaryDate.isValid
        ? summaryDate.toLocaleString({
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : t("calendar.noDate", "No date"),
    duration: formatDurationLabel(currentDuration, t),
    space: currentParent?.title?.trim() || t("common.none", "None"),
    type: isTask ? t("calendar.task", "Task") : t("calendar.event", "Event"),
  };

  // An in-progress draft (the user has typed a title) should not be lost to an
  // accidental tap outside the non-modal drawer. `onDraftSave` isn't called on
  // dismiss, so confirm before discarding rather than silently dropping it.
  const draftHasContent = () => {
    const blocks = draftContentRef.current?.blocks;
    return !!blocks && extractTitleFromBlocks(blocks).trim().length > 0;
  };
  const requestClose = () => {
    if (isDraft && draftHasContent()) {
      void getConfirmation({
        title: t("calendar.discardDraftTitle", "Discard this event?"),
        description: t(
          "calendar.discardDraftBody",
          "You've started creating this event. Discard it?",
        ),
        cancelText: t("calendar.keepEditing", "Keep editing"),
        confirmText: t("common.discard", "Discard"),
      }).then((confirmed) => {
        if (confirmed) handleClose();
      });
      return;
    }
    handleClose();
  };

  const duplicateButton =
    pageId && onDuplicate ? (
      <button
        type="button"
        className={style.previewCloseBtn}
        onClick={handleDuplicate}
        aria-label={t("calendar.duplicateEvent", "Duplicate event")}
        title={t("calendar.duplicateEvent", "Duplicate event")}
      >
        <Copy size={16} />
      </button>
    ) : null;

  const mobileHeader = (
    <div className={`${style.previewPopoverHeader} shrink-0`}>
      {pageId && (
        <Link to={`/page/${pageId}`} className={style.previewOpenLink}>
          <Maximize2 size={14} />
          {t("page.openPage", "Open page")}
        </Link>
      )}
      <div className={style.previewHeaderActions}>
        {duplicateButton}
        {pageId && (
          <button
            type="button"
            className={style.previewDeleteIconBtn}
            onClick={handleDelete}
            disabled={isDeleting}
            aria-label={t("calendar.deleteEvent", "Delete event")}
            title={t("calendar.deleteEvent", "Delete event")}
          >
            <Trash2 size={16} />
          </button>
        )}
        <button
          type="button"
          className={style.previewCloseBtn}
          onClick={requestClose}
          aria-label={t("editor.closePreview", "Close preview")}
          title={t("editor.closePreview", "Close preview")}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );

  const mobileScheduleFields = (
    <div className={style.previewDetailsBody}>
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
    </div>
  );

  const draftSpaceRow =
    isDraft && spaces.length > 1 && draftTargetSpaceId ? (
      <div className={style.previewRow}>
        <Box size={14} className={style.previewRowIcon} />
        <Select
          value={draftTargetSpaceId}
          onValueChange={handleDraftSpaceChange}
        >
          <SelectTrigger
            size="sm"
            className="flex-1"
            aria-label={t("space.selectSpace", "Select space")}
          >
            <SelectValue
              placeholder={t("space.selectSpace", "Select space")}
            />
          </SelectTrigger>
          <SelectContent>
            {spaces.map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name || t("space.untitled", "Untitled space")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ) : null;

  // Google-Calendar-style draft chrome (mobile). A top action bar (Cancel /
  // Save) sits above a scrollable body: title, then the date + duration rows,
  // the drill-down parent tags, and finally the Task/Event toggle. The sheet
  // itself drags up to a taller detent, so there's no separate full-screen mode.
  const draftTopBar = (
    <div className={style.draftTopBar}>
      <button
        type="button"
        className={style.draftTopBarAction}
        onClick={requestClose}
      >
        {t("common.cancel", "Cancel")}
      </button>
      <button
        type="button"
        className={`${style.draftTopBarAction} ${style.draftTopBarSave}`}
        onClick={handleDraftSaveClick}
      >
        {t("common.save", "Save")}
      </button>
    </div>
  );

  const draftBody = (
    <div className={style.draftScroll}>
      <div className={style.draftTitleWrap}>{editor}</div>

      <div className={style.draftSection}>
        <div className={style.previewRow}>
          <Calendar size={16} className={style.previewRowIcon} />
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
          <Clock size={16} className={style.previewRowIcon} />
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
        {draftSpaceRow}
      </div>

      <div className={style.draftSection}>
        <div className={style.draftSectionHeader}>
          <FolderOpen size={16} className={style.previewRowIcon} />
          <span>{t("calendar.parentPage", "Parent page")}</span>
        </div>
        <DraftTagPicker
          spaceId={draftTargetSpaceId}
          value={currentParent}
          onChange={handleParentChange}
        />
      </div>

      <div className={style.draftSection}>{taskEventRow}</div>
    </div>
  );

  if (isMobile && isDraft) {
    return (
      <BottomSheet
        open={isActive}
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
        variant="peek"
        className="p-0"
      >
        {draftTopBar}
        {draftBody}
      </BottomSheet>
    );
  }

  if (isMobile) {
    // Existing event: collapsible schedule summary, then the page body.
    return (
      <BottomSheet
        open={isActive}
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
        variant="sheet"
        className="p-0"
      >
        {mobileHeader}
        <div className={`${style.previewDetails} shrink-0`}>
          <button
            type="button"
            className={style.previewDetailsSummary}
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
          >
            <Calendar size={14} className={style.previewRowIcon} />
            <span className={style.previewDetailsSummaryText}>
              <span className={style.previewDetailsSummaryPrimary}>
                {scheduleSummary.when} · {scheduleSummary.duration}
              </span>
              <span className={style.previewDetailsSummaryMeta}>
                {scheduleSummary.space} · {scheduleSummary.type}
              </span>
            </span>
            <ChevronDown
              size={18}
              className={`${style.previewDetailsChevron} ${detailsOpen ? style.previewDetailsChevronOpen : ""}`}
            />
          </button>
          <AnimatePresence initial={false}>
            {detailsOpen && (
              <motion.div
                key="details"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
              >
                {mobileScheduleFields}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden border-t border-border">
          {editor}
        </div>
      </BottomSheet>
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
      {draftSpaceRow}
      {isDraft ? (
        // Drafts reuse the mobile sheet's drill-down parent picker, with a
        // search accelerator in the header: the magnifier swaps the tag rows
        // for a flat all-pages search, and picking a result (or Esc) swaps
        // back. The remounted picker opens its drill path to the selection.
        <>
          <div className={style.draftSectionHeader}>
            <FolderOpen size={14} className={style.previewRowIcon} />
            <span>{t("calendar.parentPage", "Parent page")}</span>
            <button
              type="button"
              className={`${style.draftSectionHeaderAction} ${parentSearchOpen ? style.draftSectionHeaderActionActive : ""}`}
              onClick={() => setParentSearchOpen((open) => !open)}
              aria-expanded={parentSearchOpen}
              aria-label={t("calendar.findParentPage", "Find a page")}
              title={t("calendar.findParentPage", "Find a page")}
            >
              <Search size={14} />
            </button>
          </div>
          {parentSearchOpen ? (
            <DraftParentSearch
              spaceId={draftTargetSpaceId}
              onSelect={(page) => {
                handleParentChange(page);
                setParentSearchOpen(false);
              }}
              onCancel={() => setParentSearchOpen(false)}
            />
          ) : (
            <DraftTagPicker
              spaceId={draftTargetSpaceId}
              value={currentParent}
              onChange={handleParentChange}
            />
          )}
        </>
      ) : (
        <div className={style.previewRow}>
          <FolderOpen size={14} className={style.previewRowIcon} />
          <PagePicker
            spaceId={activeSpaceId}
            value={currentParent}
            onChange={handleParentChange}
            excludeId={pageId || undefined}
          />
        </div>
      )}
      {taskEventRow}
      {pageId && (
        <div className={style.previewRow}>
          <Maximize2 size={14} className={style.previewRowIcon} />
          <Link to={`/page/${pageId}`} className={style.previewOpenLink}>
            {t("page.openPage", "Open page")}
          </Link>
        </div>
      )}
    </>
  );

  // Desktop body: a draft leads with its title field — the popover's primary
  // input — above the schedule rows, with the footer pinned to the bottom.
  // The middle scrolls because the drill-down parent rows grow vertically.
  // An existing event keeps the page body below the schedule rows.
  const desktopBody = isDraft ? (
    <>
      <div className={style.previewDraftScroll}>
        <div className={style.previewDraftTitleArea}>{editor}</div>
        {scheduleRows}
      </div>
      {draftFooter}
    </>
  ) : (
    <>
      {scheduleRows}
      <div className={style.previewEditorArea}>{editor}</div>
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
              <div className={style.previewHeaderActions}>
                {duplicateButton}
                {pageId && (
                  <button
                    type="button"
                    className={style.previewDeleteIconBtn}
                    onClick={handleDelete}
                    disabled={isDeleting}
                    aria-label={t("calendar.deleteEvent", "Delete event")}
                    title={t("calendar.deleteEvent", "Delete event")}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className={style.previewCloseBtn}
                  onClick={handleClose}
                  aria-label={t("editor.closePreview", "Close preview")}
                  title={t("editor.closePreview", "Close preview")}
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            {desktopBody}
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
            onPointerDown={(e) => e.stopPropagation()}
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
              <div className={style.previewHeaderActions}>
                {duplicateButton}
                {pageId && (
                  <button
                    type="button"
                    className={style.previewDeleteIconBtn}
                    onClick={handleDelete}
                    disabled={isDeleting}
                    aria-label={t("calendar.deleteEvent", "Delete event")}
                    title={t("calendar.deleteEvent", "Delete event")}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className={style.previewCloseBtn}
                  onClick={handleClose}
                  aria-label={t("editor.closePreview", "Close preview")}
                  title={t("editor.closePreview", "Close preview")}
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            {desktopBody}
            <div
              className={style.previewCornerTL}
              onPointerDown={(e) =>
                handleResizePointerDown(e, "both", !isRtl, true)
              }
            />
            <div
              className={style.previewCornerTR}
              onPointerDown={(e) =>
                handleResizePointerDown(e, "both", isRtl, true)
              }
            />
            <div
              className={style.previewCornerBL}
              onPointerDown={(e) => handleResizePointerDown(e, "both", !isRtl)}
            />
            <div
              className={style.previewCornerBR}
              onPointerDown={(e) => handleResizePointerDown(e, "both", isRtl)}
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
              onPointerDown={(e) => handleResizePointerDown(e, "x", !isRtl)}
            />
            <div
              className={style.previewResizeBarRight}
              onPointerDown={(e) => handleResizePointerDown(e, "x", isRtl)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
