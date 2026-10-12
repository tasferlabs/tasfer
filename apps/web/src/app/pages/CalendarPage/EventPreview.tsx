import DateTimePicker from "@/components/datetimepickers/DateTimePicker";
import { useConfirmation } from "@/app/components/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Switch } from "@/components/ui/switch";
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
import {
  formatDatePreferred,
  formatTimePreferred,
  getResolvedTimezone,
} from "@/lib/dateTimePreferences";
import { useDateTimePrefs } from "@/app/contexts/DateTimePrefsContext";
import {
  OWN_PREF_KEYS,
  useOwnPrefsStore,
} from "@/app/contexts/OwnPrefsContext";
import {
  forgetParent,
  getLastParent,
  recordParentUse,
  type RecentParent,
} from "@/lib/parentUsage";
import { DURATION_OPTIONS, formatDurationLabel } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  Archive,
  Calendar,
  CalendarDays,
  Box,
  Clock,
  Copy,
  FolderOpen,
  GripHorizontal,
  Info,
  Maximize2,
  Search,
  SlidersHorizontal,
  Square,
  SquareCheck,
  Sun,
  Type,
  X,
} from "lucide-react";
import { DateTime } from "luxon";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import { Link } from "react-router-dom";
import {
  forkOccurrence,
  useDeletePage,
  updatePage as updatePageApi,
  useGetPage,
  useGetPages,
  useMovePage,
  useUpdatePage,
  type ICalendarPage,
  type ISearchPage,
} from "../../api/pages.api";
import { SpaceSelect } from "../../components/SpaceSelect";
import { useSidebarPanel } from "../../contexts/SidebarPanelContext";
import { useSpaces } from "../../contexts/SpaceContext";
import { useDebouncedSave } from "../../hooks/useDebouncedSave";
import useMobileLayout from "../../hooks/useMobileLayout";
import { MountedEditor } from "../../MountedEditor";
import { EventPageDoc } from "./EventPageDoc";
import { EventSection } from "./EventSection";
import { TitleEditor } from "../../TitleEditor";
import { appSchema } from "../../../editorSchema";
import { DraftParentSearch, DraftTagPicker } from "./DraftTagPicker";
import type { PageFrontier } from "@/platform/types";
import type { DraftEvent } from "./CalendarPage";
import {
  KEYBOARD_CREATE_MINUTES,
  KEYBOARD_CREATE_START_MINUTES,
  MINUTES_PER_DAY,
} from "./utils";
import { DraftReminderRow, ReminderRow } from "@/reminders/ReminderRow";
import type { ReminderSetting } from "@/reminders/reminders";
import { RepeatRow } from "./RepeatRow";
import { describeRecurrence } from "./recurrenceLabels";
import type {
  ChangeMessages,
  EntryScheduleChange,
} from "./useOccurrenceActions";
import style from "./CalendarPage.module.css";

const DEFAULT_WIDTH = 450;
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

/** The schedule an edit changes; the host keeps both sides for undo. */
export interface ScheduleFields {
  scheduledAt: string | null;
  duration: number | null;
  allDay?: boolean | null;
}

export function EventPreview({
  pageId,
  occurrence = null,
  onOccurrenceReschedule,
  onOccurrenceArchive,
  anchor,
  onClose,
  sidebarMode,
  onSidebarModeChange,
  onDuplicate,
  draft,
  onDraftDiscard,
  onDraftSave,
  onDraftScheduleChange,
  onDraftContentChange,
  onArchived,
  onScheduleEdited,
  onTaskToggled,
  onToggleDone,
  calendarInteractionActive = false,
}: {
  pageId: string | null;
  /**
   * Set when the preview shows one occurrence of a repeating event. `pageId`
   * is then the page holding its notes: its own, or the series' until someone
   * writes into it. Schedule edits and archiving go to the host, which asks
   * which occurrences they cover.
   */
  occurrence?: ICalendarPage | null;
  onOccurrenceReschedule?: (
    entry: ICalendarPage,
    change: EntryScheduleChange,
    messages: ChangeMessages,
  ) => Promise<void>;
  onOccurrenceArchive?: (entry: ICalendarPage) => Promise<void>;
  anchor: DOMRect | null;
  // Requests a close. The host confirms before dropping an in-progress draft, so
  // every dismissal affordance here can call it unconditionally.
  onClose: () => void;
  sidebarMode: boolean;
  onSidebarModeChange: (mode: boolean) => void;
  // Duplicate the currently-previewed event into a new page and select it.
  onDuplicate?: (pageId: string) => void;
  draft?: DraftEvent | null;
  // Drops the draft without confirming — for the footer's Cancel, where the
  // discard is the user's stated intent.
  onDraftDiscard?: () => void;
  onDraftSave?: (
    blocks?: Block[],
    clock?: unknown,
    parentId?: string | null,
    task?: boolean,
    spaceId?: string,
    // The reminder picked before saving; `undefined` keeps the default.
    reminder?: ReminderSetting,
    // The repeat rule picked before saving, if any.
    recurrence?: string,
  ) => void;
  // Draft schedule edits flow up so the grid's `__draft__` card stays in sync
  // with the sheet's date/duration fields (two-way with grid drag/resize).
  onDraftScheduleChange?: (
    scheduledAt: string,
    duration: number,
    allDay?: boolean,
  ) => void;
  // Reports whether the draft has a typed title, so the host can guard
  // navigation away from an in-progress draft.
  onDraftContentChange?: (hasContent: boolean) => void;
  // The three edits below are reported to the host so it can put them on the
  // calendar's undo stack — it owns that history, and holds the mutations that
  // reverse them.
  onArchived?: (pageId: string) => void;
  onScheduleEdited?: (
    pageId: string,
    before: ScheduleFields,
    after: ScheduleFields,
  ) => void;
  onTaskToggled?: (pageId: string, previousTask: boolean) => void;
  /** Tick the previewed task (or occurrence, by entry id) off, or back on. */
  onToggleDone?: (entryId: string) => void;
  // Lets the active calendar move, resize, or creation gesture own Escape.
  calendarInteractionActive?: boolean;
}) {
  const { t } = useTranslation();
  // Re-render when this person changes a date or time setting on any device.
  useDateTimePrefs();
  const isRtl = i18next.dir() === "rtl";
  const { isMobile } = useMobileLayout();
  // const isFinePointer = useResponsive("(pointer: fine)");
  const queryClient = useQueryClient();
  const popoverRef = useRef<HTMLDivElement>(null);
  const { panelRef, setHasPanel, slotMounted } = useSidebarPanel();
  const { firstSpaceId, spaces } = useSpaces();
  const { getConfirmation } = useConfirmation();
  const ownPrefs = useOwnPrefsStore();
  const calendarInteractionActiveRef = useRef(calendarInteractionActive);
  calendarInteractionActiveRef.current = calendarInteractionActive;

  // Parent page selection
  const [draftParent, setDraftParent] = useState<ISearchPage | null>(null);
  // Whether the user has answered the parent question for this draft. Once they
  // have, the pre-fill stays out of the way — including when the answer was to
  // clear it.
  const draftParentTouchedRef = useRef(false);
  // The parent a new draft opens tagged with, before it has been checked
  // against the live rows. See the pre-fill block further down.
  const [prefillParent, setPrefillParent] = useState<RecentParent | null>(null);
  // Pre-fill candidates found to point at a deleted page. This device can only
  // drop them from its own stats; another device may still list them.
  const prefillGoneRef = useRef(new Set<string>());
  // Whether the user has picked this draft's space themselves.
  const draftSpaceTouchedRef = useRef(false);
  const [draftIsTask, setDraftIsTask] = useState(true);
  const [draftSpaceId, setDraftSpaceId] = useState<string | null>(firstSpaceId);
  const [draftReminder, setDraftReminder] = useState<
    ReminderSetting | undefined
  >(undefined);
  const [draftRecurrence, setDraftRecurrence] = useState<string | null>(null);
  // Desktop draft parent picker: search mode swaps in for the drill-down rows.
  const [parentSearchOpen, setParentSearchOpen] = useState(false);
  // The "More settings" dialog (a drawer on mobile): every field of the event
  // or draft, the reminder among them.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Which field groups (time, filing) are open. They start folded so the
  // title and notes lead, and stay as left from one event to the next: someone
  // rescheduling a run of events keeps the time fields open throughout.
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const sectionOpenChange = (key: string) => (open: boolean) => {
    // A folded parent search would still claim the next Escape.
    if (!open && key === "filing") setParentSearchOpen(false);
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  };

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
  // Spaces change identity as their query settles, so they reach the reset
  // below through a ref: in its deps they would re-run it mid-draft, which is
  // exactly what the comment above rules out.
  const spacesRef = useRef(spaces);
  spacesRef.current = spaces;
  // What the preview shows. An occurrence keeps its identity when it gets
  // notes of its own and `pageId` moves from the series to them, so the panel
  // stays put instead of resetting as if another event opened.
  const shownKey = occurrence
    ? `${occurrence.seriesId}|${occurrence.occurrenceStart}`
    : pageId;
  useEffect(() => {
    if (shownKey || draftActive) {
      setSize({ ...lastSizeRef.current });
      setPos(null); // will be computed from anchor
      setDraftParent(null);
      draftParentTouchedRef.current = false;
      setDraftIsTask(true);
      setDraftReminder(undefined);
      setDraftRecurrence(null);
      draftSpaceTouchedRef.current = false;
      const pickSpace = () => {
        // A draft opens in the space the last one was filed under — on any of
        // the person's devices — not in whichever space the sidebar happens
        // to be showing. A space since deleted or left falls back to the
        // first.
        const remembered = ownPrefs.get<string | null>(
          OWN_PREF_KEYS.calendarEventSpace,
          null,
        );
        const targetSpaceId =
          remembered && spacesRef.current.some((sp) => sp.id === remembered)
            ? remembered
            : firstSpaceId;
        setDraftSpaceId(targetSpaceId);
        // Read the pre-fill candidate here, as the draft opens, rather than
        // deriving it: every draft in a run has to ask again, and only a draft
        // asks at all.
        setPrefillParent(
          pageId
            ? null
            : getLastParent(ownPrefs, targetSpaceId, {
                skip: prefillGoneRef.current,
              }),
        );
      };
      pickSpace();
      setParentSearchOpen(false);
      setSettingsOpen(false);
      // Right after launch the preferences may not have been read yet, and
      // the remembered space and stats read as absent until they are. Choose
      // again once they land, unless the person has already chosen.
      if (!ownPrefs.getSnapshot().loaded) {
        let cancelled = false;
        void ownPrefs.whenLoaded().then(() => {
          if (
            cancelled ||
            draftSpaceTouchedRef.current ||
            draftParentTouchedRef.current
          ) {
            return;
          }
          pickSpace();
        });
        return () => {
          cancelled = true;
        };
      }
    }
    // Keyed on what is shown (shownKey), not on pageId: see above.
  }, [shownKey, draftActive, firstSpaceId, ownPrefs]);

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
  const [pageFrontier, setPageFrontier] = useState<PageFrontier>();
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
      setPageFrontier(previewPage.frontier);
    }
  }, [previewPage?.blocks, previewPage?.frontier, pageId, pageSnapshot]);

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
  const draftTargetSpaceId = draftSpaceId ?? firstSpaceId;
  // The calendar draws every space's events, so everything space-scoped here —
  // the parent candidates above all — has to follow the page's own space.
  const eventSpaceId = isDraft
    ? draftTargetSpaceId
    : (previewPage?.spaceId ?? firstSpaceId);
  const eventSpaceName = eventSpaceId
    ? spaces.find((space) => space.id === eventSpaceId)?.name?.trim() ||
      t("space.untitled", "Untitled space")
    : null;

  // A space whose only pages are none — or just this one — offers no parent to
  // pick, so the whole picker (header included) stays out of the sheet.
  const { data: rootPages } = useGetPages(eventSpaceId, null);
  const hasParentCandidates = !!rootPages?.some((p) => p.id !== pageId);

  const handleDraftSpaceChange = useCallback(
    (spaceId: string) => {
      setDraftSpaceId(spaceId);
      draftSpaceTouchedRef.current = true;
      ownPrefs.set(OWN_PREF_KEYS.calendarEventSpace, spaceId);
      // Parent pages cannot cross space boundaries, so the choice — and the
      // pre-fill that would have made it — starts over in the new space.
      setDraftParent(null);
      draftParentTouchedRef.current = false;
      setPrefillParent(
        getLastParent(ownPrefs, spaceId, { skip: prefillGoneRef.current }),
      );
      setParentSearchOpen(false);
    },
    [ownPrefs],
  );

  const handleTaskToggle = useCallback(() => {
    if (isDraft) {
      setDraftIsTask((v) => !v);
      return;
    }
    if (!pageId || !previewPage) return;
    updatePage({ id: pageId, task: !previewPage.task });
    onTaskToggled?.(pageId, !!previewPage.task);
    // Optimistically update the cached page
    queryClient.setQueryData(["page", pageId], (old: any) =>
      old ? { ...old, task: !old.task } : old,
    );
    queryClient.invalidateQueries({ queryKey: ["pages"] });
  }, [isDraft, pageId, previewPage, updatePage, onTaskToggled, queryClient]);

  const handleParentChange = useCallback(
    (page: ISearchPage | null) => {
      if (isDraft) {
        // The user has answered the parent question themselves; the pre-fill
        // must not answer it again over the top of them.
        draftParentTouchedRef.current = true;
        setDraftParent(page);
        return;
      }
      if (!pageId) return;
      // Filing an existing page under a parent counts as using that parent,
      // same as drafting an event under it.
      if (page) recordParentUse(ownPrefs, eventSpaceId, page);
      // The picker keeps the chosen tag lit from `previewPage`, so paint the
      // move into the cache now rather than waiting out the round trip.
      queryClient.setQueryData(["page", pageId], (old: any) =>
        old
          ? {
              ...old,
              parentId: page?.id ?? null,
              parents: page
                ? [
                    ...(page.path ?? []),
                    {
                      id: page.id,
                      title: page.title ?? "",
                      titleMd: page.titleMd ?? undefined,
                      color: page.color ?? null,
                    },
                  ]
                : [],
            }
          : old,
      );
      movePage({ id: pageId, parentId: page?.id ?? null });
    },
    [isDraft, pageId, eventSpaceId, movePage, queryClient, ownPrefs],
  );

  // ── Pre-filling the parent of a new draft ──
  //
  // A run of events usually belongs under one page, so a fresh draft opens
  // already tagged with the parent this space was last filing under — for as
  // long as that choice is fresh (see PREFILL_FRESH_MS). The tag is visibly
  // selected in the picker and one tap clears it, so nothing is filed anywhere
  // the user can't see before saving.
  // Resolved against the live rows rather than trusted: a parent deleted since
  // it was last used must not quietly adopt a new page. Its own children row is
  // the one the picker loads anyway, so this is usually already in cache.
  const { data: prefillSiblings } = useGetPages(
    prefillParent ? draftTargetSpaceId : null,
    prefillParent?.parentId ?? null,
  );
  useEffect(() => {
    if (!isDraft || !prefillParent || draftParentTouchedRef.current) return;
    if (!prefillSiblings) return;
    const live = prefillSiblings.find((p) => p.id === prefillParent.id);
    if (!live) {
      // Its row has loaded and it is not there: deleted since. Another device
      // may still list it as the latest, so fall back to the one used before.
      prefillGoneRef.current.add(prefillParent.id);
      forgetParent(ownPrefs, draftTargetSpaceId, prefillParent.id);
      setPrefillParent(
        getLastParent(ownPrefs, draftTargetSpaceId, {
          skip: prefillGoneRef.current,
        }),
      );
      return;
    }
    setDraftParent({
      id: live.id,
      title: live.title,
      titleMd: live.titleMd,
      parentId: live.parentId,
      spaceId: live.spaceId ?? null,
      color: live.color ?? null,
      path: prefillParent.path,
    });
  }, [isDraft, prefillParent, prefillSiblings, ownPrefs, draftTargetSpaceId]);

  // Derive current parent for existing pages. `parents` is the page's own
  // ancestor chain, root first, so everything above the parent is the parent's
  // path — which is what the drill-down picker opens itself to.
  const ancestors = previewPage?.parents;
  const parentIndex =
    ancestors?.findIndex((p) => p.id === previewPage?.parentId) ?? -1;
  const parentSegment = parentIndex >= 0 ? ancestors![parentIndex] : undefined;
  const currentParent: ISearchPage | null = isDraft
    ? draftParent
    : previewPage?.parentId
      ? {
          id: previewPage.parentId,
          title: parentSegment?.title ?? null,
          titleMd: parentSegment?.titleMd ?? null,
          parentId: null,
          spaceId: previewPage.spaceId ?? null,
          color: parentSegment?.color ?? null,
          path: parentIndex > 0 ? ancestors!.slice(0, parentIndex) : null,
        }
      : null;

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
      // A pointerdown on an event card (the resize handle is inside one) starts a
      // move or resize on the grid behind the popover — not a dismissal. This
      // covers the open event's own card and the draft's, both of which stay
      // draggable while the preview is up. A genuine card *click* is separated
      // from a drag by the card itself and routes through the host's event-click
      // path, so nothing is lost by not closing here.
      if (target instanceof Element && target.closest(`.${style.eventCard}`)) {
        return;
      }
      handleClose();
    }
    // Delay listener to avoid closing on the same click that opened it
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", handlePointerDown, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isActive, handleClose, sidebarMode, isMobile]);

  // Close on Escape.
  // CAPTURE phase: the editor forwards Escape into its own key queue with
  // `stopPropagation`, so a bubble-phase listener never sees it while the title
  // or body canvas has focus — which is most of the time this preview is open.
  useEffect(() => {
    if (!isActive) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (calendarInteractionActiveRef.current) return;
      // Escape during IME composition cancels the composition; that one is the
      // editor's to handle.
      if (e.isComposing) return;
      // A modal Radix layer (date picker, combobox, or the discard confirmation
      // this close can raise) owns this Escape — dismissing that layer must not
      // also close the preview, and must not re-raise the confirmation.
      if (document.body.style.pointerEvents === "none") return;
      // The parent search is the innermost layer while it is open, so Escape
      // backs out of search mode and leaves the draft up. It has to be decided
      // here: this capture listener sits ahead of the search input's own key
      // handler, and stopping the event below would never let it run.
      if (parentSearchOpen) {
        e.preventDefault();
        e.stopPropagation();
        setParentSearchOpen(false);
        return;
      }
      // This Escape is ours: stop it here, at the earliest point in the
      // propagation path. Closing can raise the discard confirmation
      // synchronously, and a Radix layer that mounts mid-dispatch registers its
      // own document-level Escape handler in time to receive this very event and
      // dismiss itself again. Stopping also keeps the editor from treating it as
      // a selection-clear on the way out.
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isActive, handleClose, parentSearchOpen]);

  const { mutate: deletePage, isPending: isDeleting } = useDeletePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.removeQueries({ queryKey: ["page", pageId] });
      handleClose();
    },
  });

  const handleDelete = useCallback(async () => {
    if (occurrence) {
      await onOccurrenceArchive?.(occurrence);
      return;
    }
    if (!pageId || !previewPage || isDeleting) return;

    const confirmed = await getConfirmation({
      title: t("calendar.archiveEvent", "Archive page"),
      description: previewPage.hasChildren
        ? t(
            "calendar.eventHasSubPagesArchive",
            "This page has sub-pages. Archiving it moves them to the Timeline too, where you can restore them anytime.",
          )
        : t(
            "calendar.confirmArchiveEvent",
            "Archiving deletes nothing. This page moves to the Timeline, where you can restore it anytime.",
          ),
      cancelText: t("common.cancel", "Cancel"),
      confirmText: t("common.archive", "Archive"),
    });
    if (!confirmed) return;

    deletePage({ id: pageId }, { onSuccess: () => onArchived?.(pageId) });
  }, [
    deletePage,
    getConfirmation,
    isDeleting,
    onArchived,
    pageId,
    previewPage,
    t,
    occurrence,
    onOccurrenceArchive,
  ]);

  const handleDuplicate = useCallback(async () => {
    if (!pageId || !onDuplicate) return;
    // Persist any pending debounced edits so the copy reflects the latest
    // content rather than the last-saved snapshot.
    await flush();
    onDuplicate(pageId);
  }, [flush, onDuplicate, pageId]);

  const handleScheduleChange = useCallback(
    (scheduledAt: string, duration: number | null, allDay?: boolean) => {
      if (occurrence) {
        // Only what moved, so "all events" doesn't rewrite the rest.
        const change: EntryScheduleChange = {};
        if (scheduledAt !== occurrence.scheduledAt) {
          change.scheduledAt = scheduledAt;
        }
        if (duration !== occurrence.duration) change.duration = duration;
        if (allDay !== undefined && allDay !== !!occurrence.allDay) {
          change.allDay = allDay;
        }
        if (Object.keys(change).length === 0) return;
        void onOccurrenceReschedule?.(occurrence, change, {
          undoMessage: t(
            "calendar.undo.rescheduleUndone",
            "Previous time restored",
          ),
          redoMessage: t(
            "calendar.undo.rescheduleRedone",
            "Time changed again",
          ),
        });
        return;
      }
      if (!pageId) return;
      updatePage({
        id: pageId,
        scheduledAt,
        duration,
        ...(allDay !== undefined && { allDay }),
      });
      if (previewPage) {
        onScheduleEdited?.(
          pageId,
          {
            scheduledAt: previewPage.scheduledAt ?? null,
            duration: previewPage.duration ?? null,
            allDay: previewPage.allDay ?? null,
          },
          {
            scheduledAt,
            duration,
            allDay: allDay ?? previewPage.allDay ?? null,
          },
        );
      }
    },
    [
      pageId,
      previewPage,
      updatePage,
      onScheduleEdited,
      occurrence,
      onOccurrenceReschedule,
      t,
    ],
  );

  // An occurrence is a task when its series is; the page holding its notes
  // may be the series or its own.
  const isTask = isDraft
    ? draftIsTask
    : occurrence
      ? occurrence.task
      : previewPage?.task;
  // The rule a repeating event follows: the series' (an occurrence's own notes
  // page holds none), or the draft's pick.
  const repeatValue = isDraft
    ? draftRecurrence
    : (occurrence?.recurrence ?? previewPage?.recurrence ?? null);
  const isRepeating = !!repeatValue;

  // A draft picks Task or Page at the top of its settings: the choice decides
  // which fields the rows below it offer.
  const draftTypeToggle = isDraft ? (
    <div className={style.eventTypeRow}>
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
          {t("calendar.event", "Page")}
        </button>
      </div>
    </div>
  ) : null;

  const taskEventRow = isDraft ? null : (
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
          ? t("calendar.convertToEvent", "Convert to page")
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

  // Switching a repeating one would switch the whole series, and the sub-page
  // check above reads this occurrence's page, not the series'; not offered.
  const shownTaskEventRow = isRepeating ? null : taskEventRow;

  // Display time zone from Settings: the stored instant is unchanged, it is
  // just displayed and edited in the preferred zone.
  const tz = getResolvedTimezone();
  // An occurrence's own time comes from the calendar entry: its notes page
  // (the series, or its own) does not hold it.
  const savedStart = occurrence
    ? occurrence.scheduledAt
    : (previewPage?.scheduledAt ?? null);
  const savedDuration = occurrence
    ? occurrence.duration
    : (previewPage?.duration ?? null);
  const dateValue = isDraft ? (draft?.scheduledAt ?? null) : savedStart;
  const currentDuration = isDraft
    ? (draft?.duration ?? 60)
    : (savedDuration ?? 60);

  // Where the rule counts from: the series' first start.
  const repeatStart = occurrence?.seriesStart ?? dateValue;
  const isAllDay = isDraft
    ? !!draft?.allDay
    : occurrence
      ? !!occurrence.allDay
      : !!previewPage?.allDay;

  const durationLabels = useMemo(
    () => DURATION_OPTIONS.map((d) => formatDurationLabel(d, t)),
    [t],
  );

  const handleDateChange = (picked: string | null) => {
    if (!picked) return;
    // An all-day page picks a date, and is stored from the start of that day.
    const value = isAllDay
      ? DateTime.fromISO(picked, { zone: tz }).startOf("day").toUTC().toISO()
      : picked;
    if (!value) return;
    if (isDraft) {
      onDraftScheduleChange?.(value, currentDuration);
      return;
    }
    if (!savedStart) return;
    handleScheduleChange(value, savedDuration || null);
  };

  const handleDurationChange = (val: string) => {
    const idx = durationLabels.indexOf(val);
    if (idx === -1) return;
    if (isDraft) {
      if (dateValue) onDraftScheduleChange?.(dateValue, DURATION_OPTIONS[idx]);
      return;
    }
    if (savedStart) {
      handleScheduleChange(savedStart, DURATION_OPTIONS[idx]);
    }
  };

  // Switching to all day keeps the day and takes all of it; switching back
  // gives the day an hour at the start of the working day, as "c" does.
  const handleAllDayChange = (allDay: boolean) => {
    const base = dateValue
      ? DateTime.fromISO(dateValue).setZone(tz)
      : DateTime.now().setZone(tz);
    if (!base.isValid) return;
    const dayStart = base.startOf("day");
    const scheduledAt = (
      allDay ? dayStart : dayStart.plus({ minutes: KEYBOARD_CREATE_START_MINUTES })
    )
      .toUTC()
      .toISO();
    if (!scheduledAt) return;
    const duration = allDay ? MINUTES_PER_DAY : KEYBOARD_CREATE_MINUTES;
    if (isDraft) {
      onDraftScheduleChange?.(scheduledAt, duration, allDay);
      return;
    }
    if (savedStart) {
      handleScheduleChange(scheduledAt, duration, allDay);
    }
  };

  const allDayToggle = (
    <label className={style.previewAllDayToggle}>
      <span>{t("calendar.allDay", "All day")}</span>
      <Switch
        checked={isAllDay}
        onCheckedChange={handleAllDayChange}
        size="sm"
      />
    </label>
  );

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
    // Record the filing, not the browsing: the ranking that feeds the picker's
    // shortcut row (and the pre-fill above) counts events actually saved under
    // a parent, so tapping through tags to look around doesn't skew it.
    if (draftParent) recordParentUse(ownPrefs, draftTargetSpaceId, draftParent);
    onDraftSave?.(
      content?.blocks,
      null,
      draftParent?.id ?? null,
      draftIsTask,
      draftTargetSpaceId,
      draftReminder,
      draftRecurrence ?? undefined,
    );
  }, [
    onDraftSave,
    draftParent,
    draftIsTask,
    draftTargetSpaceId,
    draftReminder,
    draftRecurrence,
    ownPrefs,
  ]);

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

  // Cancel states the intent outright, so it skips the host's confirmation. The
  // fallback keeps the button live if a host doesn't wire the prop.
  const discardDraft = onDraftDiscard ?? handleClose;

  const draftFooter = isDraft ? (
    <div className={style.previewDraftFooter}>
      <Button variant="ghost" size="sm" onClick={discardDraft}>
        {t("common.cancel", "Cancel")}
      </Button>
      <Button size="sm" onClick={handleDraftSaveClick}>
        {t("common.save", "Save")}
      </Button>
    </div>
  ) : null;

  // ── Notes of a repeating event ──
  //
  // Until someone writes into an occurrence it shows the series' notes,
  // read-only: every keystroke would otherwise land in the series and change
  // what all the other occurrences say. The first tap or click in them gives
  // the occurrence a notes page of its own (a copy of the series' notes), the
  // editor moves over to it, and the click is replayed there so the caret
  // lands where it was aimed.
  const sharesSeriesNotes =
    !!occurrence && !!pageId && pageId === occurrence.seriesId;
  const pendingPressRef = useRef<{ x: number; y: number } | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const forkingRef = useRef(false);
  const startOwnNotes = useCallback(
    async (press: { x: number; y: number } | null) => {
      if (!occurrence?.seriesId || !occurrence.occurrenceStart) return;
      if (forkingRef.current) return;
      forkingRef.current = true;
      pendingPressRef.current = press;
      try {
        await forkOccurrence(occurrence.seriesId, occurrence.occurrenceStart);
        await queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
        queryClient.invalidateQueries({ queryKey: ["pages"] });
      } finally {
        forkingRef.current = false;
      }
    },
    [occurrence, queryClient],
  );
  const handleEditorReady = useCallback((instance: unknown) => {
    const press = pendingPressRef.current;
    if (!instance || !press) return;
    pendingPressRef.current = null;
    // Touch-only devices place the caret from touch events, which can't be
    // replayed faithfully; the editor's autofocus covers them.
    requestAnimationFrame(() => {
      const target = document.elementFromPoint(press.x, press.y);
      if (!(target instanceof HTMLCanvasElement)) return;
      const init: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        clientX: press.x,
        clientY: press.y,
        button: 0,
        buttons: 1,
      };
      target.dispatchEvent(new MouseEvent("mousedown", init));
      target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
    });
  }, []);

  const editor = isDraft ? (
    // The compact title editor (a single-heading window over the draft doc)
    // grows only when a long title wraps. On mobile the sheet starts compact (a
    // "peek") so the grid behind it is visible and its handles remain draggable;
    // auto-focusing would raise the keyboard and expand the sheet over the grid,
    // so defer focus until the user taps the title. Desktop keeps immediate
    // focus. Enter commits the draft (single-block window makes Enter inert in
    // the engine).
    draftDoc ? (
      <div className={style.previewTitleRow}>
        <Type size={14} className={style.previewRowIcon} aria-hidden />
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
  ) : pageSnapshot && pageId && sharesSeriesNotes ? (
    <div
      className="flex h-full flex-col"
      // A press that comes back up where it went down: a tap or click, not a
      // scroll through the notes (which cancels the pointer) or a drag.
      onPointerDownCapture={(e) => {
        pressStartRef.current =
          e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
      }}
      onPointerCancelCapture={() => {
        pressStartRef.current = null;
      }}
      onPointerUpCapture={(e) => {
        const start = pressStartRef.current;
        pressStartRef.current = null;
        if (!start) return;
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) return;
        void startOwnNotes({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className={style.previewSharedNotesHint}>
        <span>
          {t(
            "calendar.repeat.sharedNotes",
            "Every page in this series shares these notes.",
          )}
        </span>
        <button
          type="button"
          className={style.previewSharedNotesAction}
          onClick={() => void startOwnNotes(null)}
        >
          {t("calendar.repeat.ownNotes", "Write notes for this one only")}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <MountedEditor
          key={pageId}
          snapshot={pageSnapshot}
          frontier={pageFrontier}
          pageId={pageId}
          readonly
          className="h-full"
          padding={editorPadding}
          blockStyleOverrides={editorBlockStyleOverrides}
          placeholderOverrides={previewPlaceholderOverrides}
        />
      </div>
    </div>
  ) : null;

  // An event's own page splits the way a draft does: its title in a field at
  // the top, the rest of the page in a body editor below the schedule rows.
  // `layout` places the two halves; in every other state (loading, shared
  // series notes) the body slot gets `editor` and there is no title field.
  const withEventDoc = (
    layout: (title: ReactNode, body: ReactNode) => ReactNode,
  ) =>
    !isDraft && !sharesSeriesNotes && pageSnapshot && pageId ? (
      <EventPageDoc
        pageId={pageId}
        spaceId={eventSpaceId ?? undefined}
        snapshot={pageSnapshot}
        frontier={pageFrontier}
        onContentChange={handleContentChange}
        onEditorReady={handleEditorReady}
        autoFocusTitle={!isMobile}
        padding={editorPadding}
        blockStyleOverrides={editorBlockStyleOverrides}
      >
        {layout}
      </EventPageDoc>
    ) : (
      layout(null, editor)
    );

  // Each occurrence of a repeating task is ticked off on its own.
  const isDone = occurrence ? occurrence.done : !!previewPage?.done;
  const doneLabel = isDone
    ? t("calendar.markNotDone", "Mark not done")
    : t("calendar.markDone", "Mark done");
  const doneButton =
    !isDraft && isTask && pageId && onToggleDone ? (
      <button
        type="button"
        role="checkbox"
        aria-checked={isDone}
        className={`${style.previewCloseBtn} ${isDone ? style.previewDoneBtnChecked : ""}`}
        onClick={() => onToggleDone(occurrence?.id ?? pageId)}
        aria-label={doneLabel}
        title={doneLabel}
      >
        {isDone ? <SquareCheck size={16} /> : <Square size={16} />}
      </button>
    ) : null;

  const duplicateButton =
    pageId && onDuplicate ? (
      <button
        type="button"
        className={style.previewCloseBtn}
        onClick={handleDuplicate}
        aria-label={t("calendar.duplicateEvent", "Duplicate page")}
        title={t("calendar.duplicateEvent", "Duplicate page")}
      >
        <Copy size={16} />
      </button>
    ) : null;

  // Opens the dialog holding every field, the reminder among them; it has no
  // row of its own in the panel.
  const settingsButton =
    isDraft || pageId ? (
      <button
        type="button"
        className={style.previewCloseBtn}
        onClick={() => setSettingsOpen(true)}
        aria-label={t("calendar.moreSettings", "More settings")}
        title={t("calendar.moreSettings", "More settings")}
      >
        <SlidersHorizontal size={16} />
      </button>
    ) : null;

  // A task has no page of its own to open — its body lives in this preview —
  // so the full-page link belongs to events only. It waits for the fetched
  // page, or it would flash before `task` arrives on a freshly created task.
  // The empty span keeps the header's space-between from pulling the actions
  // to the start.
  const canOpenPage = Boolean(pageId) && Boolean(previewPage) && !isTask;

  const mobileHeader = (
    <div className={`${style.previewPopoverHeader} shrink-0`}>
      {canOpenPage ? (
        <Link to={`/page/${pageId}`} className={style.previewOpenLink}>
          <Maximize2 size={14} />
          {t("page.openPage", "Open page")}
        </Link>
      ) : (
        <span />
      )}
      <div className={style.previewHeaderActions}>
        {settingsButton}
        {doneButton}
        {duplicateButton}
        {pageId && (
          <button
            type="button"
            className={style.previewDeleteIconBtn}
            onClick={handleDelete}
            disabled={isDeleting}
            aria-label={t("calendar.archiveEvent", "Archive page")}
            title={t("calendar.archiveEvent", "Archive page")}
          >
            <Archive size={16} />
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
  );

  // The parent picker is the same drill-down everywhere — new draft or existing
  // event, sheet or popover: rows of tags drilled top-to-bottom, with a search
  // accelerator in the header. The magnifier swaps the tag rows for a flat
  // all-pages search, and picking a result (or Esc) swaps back. The remounted
  // picker opens its drill path to the selection. An existing page can't be its
  // own parent, so it — and with it its subtree — is left out of the rows.
  const renderParentPicker = (iconSize: number) =>
    // An occurrence's own notes page is filed under its series; the series'
    // place is changed from the series.
    !hasParentCandidates || (occurrence && previewPage?.recurrenceId) ? null : (
      <>
        <div className={style.draftSectionHeader}>
          <FolderOpen size={iconSize} className={style.previewRowIcon} />
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
            spaceId={eventSpaceId}
            excludeId={pageId || undefined}
            onSelect={(page) => {
              handleParentChange(page);
              setParentSearchOpen(false);
            }}
            onCancel={() => setParentSearchOpen(false)}
          />
        ) : (
          // An existing page's parent only arrives with the loaded page, after
          // the picker has mounted; remount it then so the drill path opens to
          // the parent instead of staying at the top level.
          <DraftTagPicker
            key={isDraft ? "draft" : `${pageId}:${previewPage ? "loaded" : ""}`}
            spaceId={eventSpaceId}
            value={currentParent}
            onChange={handleParentChange}
            excludeId={pageId || undefined}
          />
        )}
      </>
    );

  // Which space this event lives in. Only worth a row once there is more than
  // one space — but then it is the only thing on the sheet saying where the
  // event is, since the grid mixes every space together. A draft still picks its
  // target space; an existing page's is read-only, because moving one across
  // spaces recreates its whole subtree under new ids and belongs in the move
  // dialog, not in a select the user brushes past.
  const spaceRow =
    spaces.length > 1 && eventSpaceId ? (
      <div className={style.previewRow}>
        <Box size={14} className={style.previewRowIcon} />
        {isDraft ? (
          <SpaceSelect
            value={eventSpaceId}
            onChange={handleDraftSpaceChange}
            size="sm"
            className="flex-1"
            aria-label={t("space.selectSpace", "Select space")}
          />
        ) : (
          <span
            className={style.previewSpaceName}
            title={eventSpaceName ?? undefined}
          >
            {eventSpaceName}
          </span>
        )}
      </div>
    ) : null;

  // This person's reminder for the event (a repeating one's lives on its
  // series). A draft holds its pick until it is saved.
  const reminderRow = isDraft ? (
    <DraftReminderRow
      chosen={draftReminder}
      onChosenChange={setDraftReminder}
      allDay={isAllDay}
      className={style.previewRow}
      iconClassName={style.previewRowIcon}
    />
  ) : pageId && previewPage ? (
      <ReminderRow
        ownerId={previewPage.recurrenceId ?? pageId}
        allDay={!!previewPage.allDay}
        className={style.previewRow}
        iconClassName={style.previewRowIcon}
      />
    ) : null;

  // How the event or task repeats. For an occurrence the rule is its series':
  // changing it changes every occurrence.
  const handleRepeatChange = useCallback(
    (rule: string | null) => {
      if (isDraft) {
        setDraftRecurrence(rule);
        return;
      }
      const target = occurrence?.seriesId ?? pageId;
      if (!target) return;
      updatePage({ id: target, recurrence: rule });
    },
    [isDraft, occurrence, pageId, updatePage],
  );
  const repeatField =
    !repeatStart || (!isDraft && !previewPage) ? null : (
      <RepeatRow
        value={repeatValue}
        start={repeatStart}
        timezone={tz}
        onChange={handleRepeatChange}
        className={style.previewRepeatField}
        icon={false}
      />
    );

  const durationField = isAllDay ? null : (
    <div className={style.previewNarrowField}>
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
          aria-label={t("calendar.duration", "Duration")}
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
  );

  // Two fields share a line where the panel is wide enough: the start with
  // how long it runs, then all day with how it repeats. A narrow panel wraps
  // the second field under the first.
  const dateRow = (
    <div className={style.previewRow}>
      <Calendar size={14} className={style.previewRowIcon} />
      <div className={style.previewRowFields}>
        <div className={style.previewWideField}>
          <DateTimePicker
            type={isAllDay ? "date" : "datetime"}
            value={dateValue}
            onChange={handleDateChange}
            timezone={tz}
            size="small"
            fullWidth
            required
          />
        </div>
        {durationField}
      </div>
    </div>
  );

  const allDayRow = (
    <div className={style.previewRow}>
      <Sun size={14} className={style.previewRowIcon} />
      <div className={style.previewRowFields}>
        {allDayToggle}
        {repeatField}
      </div>
    </div>
  );

  // ── Field groups ──
  //
  // The panel's fields fold into two groups that read as one line each until
  // opened: when it happens (date and duration, all day and repeat) and where
  // it is filed (space, parent page, task or page). The reminder has no row
  // here: it is set from the "More settings" dialog, which repeats every field.
  const startsAt = dateValue ? DateTime.fromISO(dateValue).setZone(tz) : null;
  const timeOptions = {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  } as const;
  const timeSummary =
    startsAt && startsAt.isValid
      ? [
          formatDatePreferred(startsAt.toJSDate(), {
            weekday: "short",
            month: "short",
            day: "numeric",
            timeZone: tz,
          }),
          isAllDay
            ? t("calendar.allDay", "All day")
            : t("calendar.timeRange", {
                defaultValue: "{{start}} – {{end}}",
                start: formatTimePreferred(startsAt.toJSDate(), timeOptions),
                end: formatTimePreferred(
                  startsAt.plus({ minutes: currentDuration }).toJSDate(),
                  timeOptions,
                ),
                interpolation: { escapeValue: false },
              }),
        ].join(" · ")
      : t("calendar.noDate", "No date");
  const repeatSummary = repeatField
    ? ((repeatValue && repeatStart
        ? describeRecurrence(repeatValue, repeatStart, t)
        : null) ?? t("calendar.repeat.none", "Does not repeat"))
    : null;

  const parentPicker = renderParentPicker(14);
  const parentSummary = currentParent
    ? currentParent.title?.trim() || t("common.untitled", "Untitled")
    : t("calendar.noParentPage", "No parent page");
  // Lead with whatever the group lets you change: the parent when there is
  // one to pick, then the space, then the kind of page.
  const filingSummary = [
    parentPicker ? parentSummary : null,
    spaceRow ? eventSpaceName : null,
    shownTaskEventRow
      ? isTask
        ? t("calendar.task", "Task")
        : t("calendar.event", "Page")
      : null,
  ].filter((part): part is string => !!part);

  const renderFieldSections = (after?: ReactNode) => (
    <div className={style.eventSections}>
      <EventSection
        icon={Clock}
        primary={timeSummary}
        secondary={repeatSummary}
        open={openSections.has("time")}
        onOpenChange={sectionOpenChange("time")}
      >
        {dateRow}
        {allDayRow}
      </EventSection>
      {filingSummary.length > 0 && (
        <EventSection
          icon={FolderOpen}
          primary={filingSummary[0]}
          secondary={filingSummary.slice(1).join(" · ")}
          open={openSections.has("filing")}
          onOpenChange={sectionOpenChange("filing")}
        >
          {spaceRow}
          {parentPicker}
          {shownTaskEventRow}
        </EventSection>
      )}
      {after}
    </div>
  );

  // Every field in one place: the panel's groups plus the reminder. A draft's
  // picks are still committed by its Save; an existing event's apply at once,
  // as they do in the panel.
  const settingsTitle = isTask
    ? t("calendar.taskSettings", "Task settings")
    : t("calendar.pageSettings", "Page settings");
  const settingsFields = (
    <>
      {isDraft ? draftTypeToggle : shownTaskEventRow}
      {dateRow}
      {allDayRow}
      {reminderRow}
      {spaceRow}
      {parentPicker}
    </>
  );
  // The preview's own Escape listener stands aside while a modal layer is up,
  // so the parent search's "Escape backs out of search" is handled here.
  const handleSettingsEscape = (e: KeyboardEvent) => {
    if (!parentSearchOpen) return;
    e.preventDefault();
    setParentSearchOpen(false);
  };
  const settingsShown = !!settingsButton && isActive && settingsOpen;
  // Rendered beside the sheet or popover, never inside it: React events bubble
  // through portals, and the sheet's drag or the popover's resize handlers
  // would otherwise see pointer events from the dialog.
  const settingsDialog = !settingsButton ? null : isMobile ? (
    <Drawer open={settingsShown} onOpenChange={setSettingsOpen}>
      <DrawerContent onEscapeKeyDown={handleSettingsEscape}>
        <DrawerHeader>
          <DrawerTitle>{settingsTitle}</DrawerTitle>
        </DrawerHeader>
        <div className="pb-2">{settingsFields}</div>
        <DrawerFooter>
          <Button onClick={() => setSettingsOpen(false)}>
            {t("common.done", "Done")}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ) : (
    <Dialog open={settingsShown} onOpenChange={setSettingsOpen}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 p-0"
        aria-describedby={undefined}
        onEscapeKeyDown={handleSettingsEscape}
      >
        <DialogHeader className="px-6 pt-5 pb-2">
          <DialogTitle>{settingsTitle}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {settingsFields}
        </div>
        <DialogFooter className="border-t border-border px-4 py-3">
          <Button size="sm" onClick={() => setSettingsOpen(false)}>
            {t("common.done", "Done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Google-Calendar-style draft chrome (mobile). A top action bar (Cancel /
  // Save, with the settings icon beside Save) sits above a scrollable body:
  // title, the Task/Page toggle, then the field groups. The sheet itself drags
  // up to a taller detent, so there's no separate full-screen mode.
  const draftTopBar = (
    <div className={style.draftTopBar}>
      <button
        type="button"
        className={style.draftTopBarAction}
        onClick={discardDraft}
      >
        {t("common.cancel", "Cancel")}
      </button>
      <div className={style.draftTopBarEnd}>
        {settingsButton}
        <button
          type="button"
          className={`${style.draftTopBarAction} ${style.draftTopBarSave}`}
          onClick={handleDraftSaveClick}
        >
          {t("common.save", "Save")}
        </button>
      </div>
    </div>
  );

  const draftBody = (
    <div className={style.draftScroll}>
      <div className={style.draftTitleWrap}>{editor}</div>
      {draftTypeToggle}
      {renderFieldSections()}
    </div>
  );

  if (isMobile && isDraft) {
    return (
      <>
        <BottomSheet
          open={isActive}
          onOpenChange={(open) => {
            if (!open) handleClose();
          }}
          variant="peek"
          className="p-0"
        >
          {draftTopBar}
          {draftBody}
        </BottomSheet>
        {settingsDialog}
      </>
    );
  }

  if (isMobile) {
    // Existing event: title, collapsible schedule summary, then the page body.
    return (
      <BottomSheet
        open={isActive}
        onOpenChange={(open) => {
          if (!open) handleClose();
        }}
        variant="sheet"
        className="p-0"
      >
        {withEventDoc((title, body) => (
          <>
            {mobileHeader}
            {title && <div className="shrink-0 pt-2">{title}</div>}
            {renderFieldSections()}
            <div className="flex-1 min-h-24 overflow-hidden border-t border-border">
              {body}
            </div>
          </>
        ))}
      </BottomSheet>
    );
  }

  const openPageRow = canOpenPage ? (
    <div className={style.previewRow}>
      <Maximize2 size={14} className={style.previewRowIcon} />
      <Link to={`/page/${pageId}`} className={style.previewOpenLink}>
        {t("page.openPage", "Open page")}
      </Link>
    </div>
  ) : null;

  // Desktop body: a draft leads with its title field — the popover's primary
  // input — above the schedule rows, with the footer pinned to the bottom.
  // The middle scrolls because the drill-down parent rows grow vertically.
  // An existing event leads with its title field the same way, and keeps the
  // rest of the page in the body editor below the schedule rows. Title, rows
  // and notes scroll as one, so open rows push the notes down instead of
  // squeezing into a scroll box of their own.
  const desktopBody = isDraft ? (
    <>
      <div className={style.previewDraftScroll}>
        <div className={style.previewDraftTitleArea}>{editor}</div>
        {draftTypeToggle}
        {renderFieldSections()}
      </div>
      {draftFooter}
    </>
  ) : (
    withEventDoc((title, body) => (
      <div className={style.previewEventScroll}>
        {title && <div className={style.previewDraftTitleArea}>{title}</div>}
        {renderFieldSections(openPageRow)}
        <div className={`${style.previewEditorArea} border-t border-border`}>
          {body}
        </div>
      </div>
    ))
  );

  // Sidebar mode - portal into the left sidebar
  if (sidebarMode && panelRef.current) {
    return (
      <>
        {createPortal(
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
                    {settingsButton}
                    {doneButton}
                    {duplicateButton}
                    {pageId && (
                      <button
                        type="button"
                        className={style.previewDeleteIconBtn}
                        onClick={handleDelete}
                        disabled={isDeleting}
                        aria-label={t("calendar.archiveEvent", "Archive page")}
                        title={t("calendar.archiveEvent", "Archive page")}
                      >
                        <Archive size={16} />
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
        )}
        {settingsDialog}
      </>
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
                {settingsButton}
                {doneButton}
                {duplicateButton}
                {pageId && (
                  <button
                    type="button"
                    className={style.previewDeleteIconBtn}
                    onClick={handleDelete}
                    disabled={isDeleting}
                    aria-label={t("calendar.archiveEvent", "Archive page")}
                    title={t("calendar.archiveEvent", "Archive page")}
                  >
                    <Archive size={16} />
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
      {settingsDialog}
    </>
  );
}
