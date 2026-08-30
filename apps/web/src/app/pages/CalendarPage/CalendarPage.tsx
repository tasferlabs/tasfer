import { useMemo, useRef, useEffect, useLayoutEffect, useState, useCallback } from "react";
import { TopActionBarPortal } from "../../layout/TopActionBarSlot";
import { useNavigate, useBlocker } from "react-router-dom";
import { useConfirmation } from "@/app/components/ConfirmationDialog";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import { useSpaces } from "../../contexts/SpaceContext";
import useLocalStorage from "../../hooks/useLocalStorage";
import useMobileLayout from "../../hooks/useMobileLayout";
import type { Block } from "@tasfer/editor";
import { deriveTitles, findTitleBlock } from "@/lib/pageTitle";
import { getResolvedTimezone } from "@/lib/dateTimePreferences";
import { getPlatform } from "@/platform";
import {
  useGetCalendarPages,
  useCreatePage,
  useDeletePage,
  useUpdatePage,
  updatePage as updatePageApi,
  type ICalendarPage,
} from "../../api/pages.api";
import {
  DEFAULT_HOUR_HEIGHT,
  TOTAL_HOURS,
  SNAP_MINUTES,
  KEYBOARD_CREATE_START_MINUTES,
  KEYBOARD_CREATE_MINUTES,
  MIN_DRAG_MINUTES,
  minCreateMinutes,
  clampHourHeight,
  hourLabelStep,
  formatHour,
  formatDate,
  formatWeekRange,
  formatTime,
  formatTimeRange,
  isSameDay,
  getDayRange,
  getWeekRange,
  getWeekDays,
  pxToMinutes,
  snapPx,
  snapStartMin,
  pageToStartMin,
  layoutCalendarIntervals,
  getEventLaneInsets,
  type CalendarEventLayout,
  shortDayName,
  formatMonthLong,
  zonedWallDate,
  wallDateToUtcIso,
  wallMsToInstantMs,
  wallNow,
  type ViewMode,
} from "./utils";
import { triggerHaptic } from "@/platform/bridge";
import { EventCard } from "./EventCard";
import { EventPreview } from "./EventPreview";
import { DateTimePickerOverlay } from "@/components/datetimepickers/DateTimePickerOverlay";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { DateTime } from "luxon";
import style from "./CalendarPage.module.css";
import clsx from "clsx";

// ── Draft event (temporary, not yet saved) ──

export interface DraftEvent {
  scheduledAt: string;
  duration: number;
}

// ── Create-drag state ──

interface CreateDragState {
  startMinutes: number;
  endMinutes: number;
  date: Date;
}

// ── Pinch-zoom state ──

interface PinchState {
  startDistance: number;
  startHourHeight: number;
  /** Grid time under the initial pinch midpoint; stays put while zooming. */
  anchorHours: number;
  /** Scroll-content offset of hour 0, unaffected by the hour scale. */
  gridOffset: number;
}

/** A zoom step to be re-anchored against the timeline's scroll position. */
interface ZoomAnchor {
  anchorHours: number;
  gridOffset: number;
  viewportY: number;
}

// ── Resize state ──

interface ResizeState {
  pageId: string;
  originalDuration: number;
  originalStartMin: number;
  startY: number;
  startScrollTop: number;
}

// ── Main component ──

export default function CalendarPage() {
  const { t } = useTranslation();
  const isRtl = i18next.dir() === "rtl";
  const navigate = useNavigate();
  const { getConfirmation } = useConfirmation();
  const { isMobile } = useMobileLayout();
  const { activeSpaceId } = useSpaces();
  const timelineRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [selectedDate, setSelectedDate] = useState(() => wallNow());
  const [viewMode, setViewMode] = useLocalStorage<ViewMode>(
    "calendar-view",
    "day",
  );
  const [sidebarMode, setSidebarMode] = useLocalStorage<boolean>(
    "calendar-preview-sidebar",
    false,
  );

  // ── Zoomable hour scale ──
  //
  // `hourHeight` drives layout and changes every frame of a pinch, so it lives
  // in plain state; the stored copy is only read at mount and written once a
  // gesture settles, keeping localStorage out of the gesture's hot path.
  const [storedHourHeight, setStoredHourHeight] = useLocalStorage<number>(
    "calendar-hour-height",
    DEFAULT_HOUR_HEIGHT,
  );
  const [hourHeight, setHourHeight] = useState(() =>
    clampHourHeight(storedHourHeight ?? DEFAULT_HOUR_HEIGHT),
  );
  // Event handlers read the scale through a ref so registering them doesn't
  // depend on the current zoom.
  const hourHeightRef = useRef(hourHeight);
  hourHeightRef.current = hourHeight;
  const pinchRef = useRef<PinchState | null>(null);
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const zoomPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const labelStep = hourLabelStep(hourHeight);

  const [today, setToday] = useState(() => wallNow());
  const isToday = isSameDay(selectedDate, today);
  const [miniCalOpen, setMiniCalOpen] = useState(false);
  const tz = getResolvedTimezone();

  // Overlay state derived from selectedDate
  const [overlayYear, setOverlayYear] = useState(() =>
    String(selectedDate.getFullYear()).padStart(4, "0"),
  );
  const [overlayMonth, setOverlayMonth] = useState(() =>
    String(selectedDate.getMonth() + 1).padStart(2, "0"),
  );
  const [overlayDay, setOverlayDay] = useState(() =>
    String(selectedDate.getDate()).padStart(2, "0"),
  );

  // Sync overlay state when selectedDate changes
  useEffect(() => {
    setOverlayYear(String(selectedDate.getFullYear()).padStart(4, "0"));
    setOverlayMonth(String(selectedDate.getMonth() + 1).padStart(2, "0"));
    setOverlayDay(String(selectedDate.getDate()).padStart(2, "0"));
  }, [selectedDate]);

  // When overlay day is picked, update selectedDate
  const overlayValue = useMemo(() => {
    const y = parseInt(overlayYear);
    const m = parseInt(overlayMonth);
    const d = parseInt(overlayDay);
    if (!y || !m || !d) return null;
    return DateTime.fromObject(
      { year: y, month: m, day: d },
      { zone: tz },
    ).toISODate();
  }, [overlayYear, overlayMonth, overlayDay, tz]);

  const prevOverlayValue = useRef(overlayValue);

  // ── Event preview ──
  const previewJustClosedRef = useRef(false);
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
  const [previewAnchor, setPreviewAnchor] = useState<DOMRect | null>(null);
  const [draftEvent, setDraftEvent] = useState<DraftEvent | null>(null);
  // Whether the open draft has a typed title. Lifted from EventPreview so we can
  // guard navigation away from an in-progress draft (Google-Calendar style).
  const [draftHasContent, setDraftHasContent] = useState(false);
  // Set synchronously while a draft is being committed so the discard guards
  // (in-page + route) don't fire during the create → onSuccess window.
  const savingDraftRef = useRef(false);
  const queryClient = useQueryClient();

  // Tear down the preview without asking. Only for paths that already carry an
  // explicit discard intent (the draft footer's Cancel); everything else goes
  // through `handlePreviewClose`.
  const closePreviewNow = useCallback(() => {
    setPreviewPageId(null);
    setPreviewAnchor(null);
    setDraftEvent(null);
    setDraftHasContent(false);
    previewJustClosedRef.current = true;
    requestAnimationFrame(() => {
      previewJustClosedRef.current = false;
    });
  }, []);

  // Show the discard confirmation before running `proceed` when a titled draft
  // is open; drop an empty draft silently; pass through when there's no draft
  // (or one is being saved). `onCancel` runs when the user keeps editing — used
  // by navigations that need to visually revert (swipe snap-back, mini-cal).
  // Used to gate all in-page navigation.
  const guardDiscard = useCallback(
    (proceed: () => void, onCancel?: () => void) => {
      if (!draftEvent || savingDraftRef.current) {
        proceed();
        return;
      }
      if (!draftHasContent) {
        setDraftEvent(null);
        setPreviewAnchor(null);
        proceed();
        return;
      }
      void getConfirmation({
        title: t("calendar.discardDraftTitle", "Discard this page?"),
        description: t(
          "calendar.discardDraftBody",
          "You've started creating this page. Discard it?",
        ),
        cancelText: t("calendar.keepEditing", "Keep editing"),
        confirmText: t("common.discard", "Discard"),
      }).then((confirmed) => {
        if (confirmed) {
          setDraftEvent(null);
          setPreviewAnchor(null);
          setDraftHasContent(false);
          proceed();
        } else {
          onCancel?.();
        }
      });
    },
    [draftEvent, draftHasContent, getConfirmation, t],
  );

  // The single close sink for the preview. Every dismissal the preview exposes
  // (Escape, click-outside, the X buttons, the mobile sheet's swipe-down) funnels
  // here, so the discard confirmation is structural instead of wired per
  // affordance — a new dismissal path can't silently drop a draft.
  const handlePreviewClose = useCallback(() => {
    guardDiscard(closePreviewNow);
  }, [guardDiscard, closePreviewNow]);

  // Apply a mini-calendar date pick, guarding an in-progress draft. On cancel,
  // revert the overlay fields back to the current selection so the picker
  // doesn't reflect the rejected date and doesn't re-trigger this effect.
  useEffect(() => {
    if (overlayValue && overlayValue !== prevOverlayValue.current) {
      const target = overlayValue;
      prevOverlayValue.current = target;
      guardDiscard(
        () => {
          // Parse as a wall date: the picked Y/M/D are display-zone components.
          setSelectedDate(DateTime.fromISO(target).toJSDate());
          setMiniCalOpen(false);
        },
        () => {
          // Match how `overlayValue` is derived so the recomputed value equals
          // this and the effect's guard sees no change.
          const revertISO = DateTime.fromObject(
            {
              year: selectedDate.getFullYear(),
              month: selectedDate.getMonth() + 1,
              day: selectedDate.getDate(),
            },
            { zone: tz },
          ).toISODate();
          prevOverlayValue.current = revertISO;
          setOverlayYear(String(selectedDate.getFullYear()).padStart(4, "0"));
          setOverlayMonth(
            String(selectedDate.getMonth() + 1).padStart(2, "0"),
          );
          setOverlayDay(String(selectedDate.getDate()).padStart(2, "0"));
          setMiniCalOpen(false);
        },
      );
    } else {
      prevOverlayValue.current = overlayValue;
    }
  }, [overlayValue, tz, guardDiscard, selectedDate]);

  // Guard route navigation away from the calendar (link clicks, back/forward,
  // navigate()) while a titled draft is open, using the same discard dialog as
  // the in-page guards so the copy is consistent.
  const routeBlocker = useBlocker(draftHasContent && !savingDraftRef.current);
  useEffect(() => {
    if (routeBlocker.state !== "blocked") return;
    void getConfirmation({
      title: t("calendar.discardDraftTitle", "Discard this page?"),
      description: t(
        "calendar.discardDraftBody",
        "You've started creating this page. Discard it?",
      ),
      cancelText: t("calendar.keepEditing", "Keep editing"),
      confirmText: t("common.discard", "Discard"),
    }).then((confirmed) => {
      if (confirmed) routeBlocker.proceed();
      else routeBlocker.reset();
    });
  }, [routeBlocker, getConfirmation, t]);

  const handleEventClick = useCallback(
    (pageId: string, rect: DOMRect) => {
      if (pageId === "__draft__") {
        // Draft event clicked - just set anchor for positioning
        setPreviewAnchor(rect);
        return;
      }
      // Opening another event replaces the draft, so confirm first.
      guardDiscard(() => {
        setDraftEvent(null);
        setPreviewPageId(pageId);
        setPreviewAnchor(rect);
      });
    },
    [guardDiscard],
  );

  // Compute adjacent dates for swipe panels
  const prevDate = useMemo(() => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + (viewMode === "week" ? -7 : -1));
    return d;
  }, [selectedDate, viewMode]);

  const nextDate = useMemo(() => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + (viewMode === "week" ? 7 : 1));
    return d;
  }, [selectedDate, viewMode]);

  // Compute query range covering prev + current + next for swipe panels.
  // Ranges are wall-date epochs; the query wants real instants.
  const { start, end } = useMemo(() => {
    const prevRange =
      viewMode === "week" ? getWeekRange(prevDate) : getDayRange(prevDate);
    const nextRange =
      viewMode === "week" ? getWeekRange(nextDate) : getDayRange(nextDate);
    return {
      start: wallMsToInstantMs(prevRange.start),
      end: wallMsToInstantMs(nextRange.end),
    };
  }, [prevDate, nextDate, viewMode]);

  const weekDays = useMemo(() => getWeekDays(selectedDate), [selectedDate]);
  const prevWeekDays = useMemo(() => getWeekDays(prevDate), [prevDate]);
  const nextWeekDays = useMemo(() => getWeekDays(nextDate), [nextDate]);

  const { data: pages } = useGetCalendarPages(activeSpaceId, start, end);

  const { mutate: createPage } = useCreatePage({
    onSuccess: async (newPage) => {
      // Save draft title and body to the new page
      const { blocks } = draftSnapshotRef.current;
      if (blocks) {
        await updatePageApi({
          id: newPage.id,
          ...deriveTitles(blocks),
        });
        // Persist the typed content as CRDT ops so the editor shows it on open.
        // writeBlocks reuses the existing init block for the first block so we
        // don't end up with two heading1 blocks.
        await getPlatform().ops.writeBlocks(newPage.id, blocks);
      }
      draftSnapshotRef.current = {};
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      setDraftEvent(null);
      setDraftHasContent(false);
      savingDraftRef.current = false;
      setPreviewPageId(newPage.id);
      setPreviewAnchor(null);
    },
    onError: () => {
      savingDraftRef.current = false;
    },
  });

  const { mutate: updatePage } = useUpdatePage({
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ["calendar-pages"] });
      const previousData = queryClient.getQueriesData<ICalendarPage[]>({
        queryKey: ["calendar-pages"],
      });

      // Optimistically update the event in the cache
      queryClient.setQueriesData<ICalendarPage[]>(
        { queryKey: ["calendar-pages"] },
        (old) => {
          if (!old) return old;
          return old.map((p) => {
            if (p.id !== variables.id) return p;
            return {
              ...p,
              ...(variables.scheduledAt !== undefined && {
                scheduledAt: variables.scheduledAt as string,
              }),
              ...(variables.duration !== undefined && {
                duration: variables.duration,
              }),
            };
          });
        },
      );

      return { previousData };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousData) {
        for (const [key, data] of context.previousData) {
          queryClient.setQueryData(key, data);
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["page", previewPageId] });
    },
  });

  const { mutate: deletePage } = useDeletePage({
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.removeQueries({ queryKey: ["page", variables.id] });
      if (previewPageId === variables.id) closePreviewNow();
    },
  });

  const handleEventDelete = useCallback(
    async (pageId: string) => {
      let hasChildren = false;
      try {
        hasChildren = (await getPlatform().pages.get(pageId)).hasChildren;
      } catch {
        // The generic confirmation is still safe if page details are unavailable.
      }

      const confirmed = await getConfirmation({
        title: t("calendar.archiveEvent", "Archive event"),
        description: hasChildren
          ? t(
              "calendar.eventHasSubPagesArchive",
              "This page has sub-pages. Archiving it moves them to the Archive too, where you can restore them anytime.",
            )
          : t(
              "calendar.confirmArchiveEvent",
              "Archiving deletes nothing. This page moves to the Archive, where you can restore it anytime.",
            ),
        cancelText: t("common.cancel", "Cancel"),
        confirmText: t("common.archive", "Archive"),
      });
      if (confirmed) deletePage({ id: pageId });
    },
    [deletePage, getConfirmation, t],
  );

  const createPageAtTime = useCallback(
    (startMinutes: number, durationMinutes: number, date?: Date) => {
      if (!activeSpaceId) return;
      const scheduledDate = new Date(date || selectedDate);
      scheduledDate.setHours(0, 0, 0, 0);
      scheduledDate.setMinutes(startMinutes);
      // A new draft replaces any open one. The grid's create gestures refuse to
      // start while a draft is open in popover mode, but sidebar mode leaves the
      // grid interactive, so guard here rather than trusting the callers.
      guardDiscard(() => {
        setDraftEvent({
          scheduledAt: wallDateToUtcIso(scheduledDate),
          duration: durationMinutes,
        });
        setPreviewPageId(null);
        setPreviewAnchor(null);
      });
    },
    [activeSpaceId, selectedDate, guardDiscard],
  );

  // Duplicate an existing event into a new page: copies its title, parent,
  // color, duration, and task flag, but NOT its body — a duplicated event is a
  // fresh occasion, not a second copy of the original's notes. `scheduledAt`
  // overrides the copy's time (used by Ctrl/Cmd-drag to drop the copy at a new
  // slot); when omitted the copy lands at the original's time. `select` opens
  // the new event's preview afterwards (used by the Duplicate button).
  const duplicatePage = useCallback(
    async (
      sourceId: string,
      opts?: { scheduledAt?: string; select?: boolean },
    ) => {
      if (!activeSpaceId) return;
      const platform = getPlatform();
      let src;
      try {
        src = await platform.pages.get(sourceId);
      } catch {
        return;
      }
      const newPage = await platform.pages.create({
        title: src.title,
        titleMd: src.titleMd,
        parentId: src.parentId,
        spaceId: src.spaceId ?? activeSpaceId,
        scheduledAt: opts?.scheduledAt ?? src.scheduledAt ?? undefined,
        duration: src.duration ?? undefined,
        allDay: src.allDay ?? undefined,
        task: src.task,
      });
      // Color isn't part of the create payload, so apply it in a follow-up.
      if (src.color) {
        await updatePageApi({ id: newPage.id, color: src.color });
      }
      // Carry the heading over as content, not just as the title columns: those
      // columns are a derived cache of the doc, so a copy whose doc was left
      // empty would have its title wiped the next time the page is rebuilt.
      // writeBlocks reuses the new page's init block for the first block, so
      // writing the title block on its own leaves the copy with that heading
      // and an empty body.
      const titleBlock = findTitleBlock(src.blocks ?? undefined);
      if (titleBlock) {
        await getPlatform().ops.writeBlocks(newPage.id, [titleBlock]);
      }
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      if (opts?.select) {
        setPreviewPageId(newPage.id);
        setPreviewAnchor(null);
      }
    },
    [activeSpaceId, queryClient],
  );

  // After the draft card renders, resolve its position as the anchor
  useEffect(() => {
    if (!draftEvent || previewAnchor) return;
    const frame = requestAnimationFrame(() => {
      const el = document.querySelector(
        `[data-draft-card]`,
      ) as HTMLElement | null;
      if (el) {
        setPreviewAnchor(el.getBoundingClientRect());
        // On mobile the draft sheet covers the lower part of the grid, so scroll
        // the new event up near the top of the timeline where it stays visible
        // (and draggable) above the sheet.
        const timeline = timelineRef.current;
        if (isMobile && timeline) {
          const cardRect = el.getBoundingClientRect();
          const tlRect = timeline.getBoundingClientRect();
          const target =
            timeline.scrollTop + (cardRect.top - tlRect.top) - 72;
          timeline.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [draftEvent, previewAnchor, isMobile]);

  const draftSnapshotRef = useRef<{ blocks?: Block[] }>(
    {},
  );

  const handleDraftSave = useCallback(
    (
      blocks?: Block[],
      _clock?: unknown,
      parentId?: string | null,
      task?: boolean,
      spaceId?: string,
    ) => {
      const targetSpaceId = spaceId ?? activeSpaceId;
      if (!draftEvent || !targetSpaceId) return;
      // Mark saving before the async create so the discard guards pass through
      // rather than prompting while the draft is being committed.
      savingDraftRef.current = true;
      draftSnapshotRef.current = { blocks };
      createPage({
        ...(blocks ? deriveTitles(blocks) : { title: "" }),
        parentId: parentId ?? null,
        spaceId: targetSpaceId,
        scheduledAt: draftEvent.scheduledAt,
        duration: draftEvent.duration,
        task: task ?? true,
      });
    },
    [draftEvent, activeSpaceId, createPage],
  );

  // Separate all-day and timed events
  const { timedPages, allDayPages } = useMemo(() => {
    const timedPages: ICalendarPage[] = [];
    const allDayPages: ICalendarPage[] = [];
    if (!pages) return { timedPages, allDayPages };
    for (const page of pages) {
      if (page.allDay) {
        allDayPages.push(page);
      } else {
        timedPages.push(page);
      }
    }
    // Include draft event as a temporary calendar page
    if (draftEvent) {
      timedPages.push({
        id: "__draft__",
        title: "",
        parentId: null,
        order: 0,
        color: null,
        scheduledAt: draftEvent.scheduledAt,
        duration: draftEvent.duration,
        allDay: false,
        recurrenceId: null,
        task: true,
        path: null,
        createdAt: new Date().toISOString(),
      });
    }
    return { timedPages, allDayPages };
  }, [pages, draftEvent]);

  // Group timed pages by day (for week view)
  const pagesByDay = useMemo(() => {
    const map = new Map<string, ICalendarPage[]>();
    for (const page of timedPages) {
      const d = zonedWallDate(page.scheduledAt);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(page);
    }
    return map;
  }, [timedPages]);

  function getPagesForDay(date: Date): ICalendarPage[] {
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    return pagesByDay.get(key) || [];
  }

  function getTransientIntervalsForDay(day: Date) {
    const intervals: {
      id: string;
      startMinutes: number;
      duration: number;
    }[] = [];

    if (createDrag && isSameDay(createDrag.date, day)) {
      intervals.push({
        id: "__create_ghost__",
        startMinutes: createDrag.startMinutes,
        duration: createDrag.endMinutes - createDrag.startMinutes,
      });
    }

    if (activeDragPage) {
      const dragDay =
        dragTargetDay || zonedWallDate(activeDragPage.scheduledAt);
      if (isSameDay(dragDay, day)) {
        const startMinutes = Math.max(
          0,
          Math.min(
            pageToStartMin(activeDragPage) + dragDeltaMinutes,
            TOTAL_HOURS * 60 - SNAP_MINUTES,
          ),
        );
        intervals.push({
          id: "__drag_ghost__",
          startMinutes,
          duration: activeDragPage.duration || 60,
        });
      }
    }

    return intervals;
  }

  function getLaidOutPages(dayPages: ICalendarPage[], day?: Date) {
    const displayPages = dayPages.map((page) =>
      resize?.pageId === page.id && resizeDuration !== null
        ? { ...page, duration: resizeDuration }
        : page,
    );
    const transientIntervals = day ? getTransientIntervalsForDay(day) : [];
    const layouts = layoutCalendarIntervals(
      [
        ...displayPages
          .filter(
            (page) =>
              !activeDragPage ||
              page.id !== activeDragPage.id ||
              transientIntervals.length === 0,
          )
          .map((page) => ({
            id: page.id,
            startMinutes: pageToStartMin(page),
            duration: page.duration || 60,
          })),
        ...transientIntervals,
      ],
    );
    return displayPages.map((page) => ({ page, layout: layouts.get(page.id) }));
  }

  function getTransientLayout(
    day: Date,
    interval: { id: string; startMinutes: number; duration: number },
    excludedPageId?: string,
  ): CalendarEventLayout | undefined {
    const intervals = getPagesForDay(day)
      .filter((page) => page.id !== excludedPageId)
      .map((page) => ({
        id: page.id,
        startMinutes: pageToStartMin(page),
        duration: page.duration || 60,
      }));
    intervals.push(interval);
    return layoutCalendarIntervals(intervals).get(interval.id);
  }

  // Scroll to current hour on mount
  useEffect(() => {
    if (timelineRef.current) {
      const currentHour = wallNow().getHours();
      const targetScroll =
        currentHour * hourHeightRef.current -
        timelineRef.current.clientHeight / 3;
      timelineRef.current.scrollTop = Math.max(0, targetScroll);
    }
  }, [selectedDate, viewMode]);

  // ── Day navigation ──
  function goToDay(offset: number) {
    guardDiscard(() => {
      setSelectedDate((prev) => {
        const next = new Date(prev);
        if (viewMode === "week") {
          next.setDate(next.getDate() + offset * 7);
        } else {
          next.setDate(next.getDate() + offset);
        }
        return next;
      });
    });
  }

  function goToToday() {
    guardDiscard(() => setSelectedDate(wallNow()));
  }

  // ── dnd-kit: drag to move events ──
  // A mouse drag arms on distance alone: nothing competes with it, so waiting
  // would only make the grab feel laggy. The threshold matches the click slop in
  // EventCard, so a press either opens the event or drags it, never both.
  // Touch keeps a press delay because the same gesture also scrolls the
  // timeline; `tolerance` cancels the press when the finger travels first.
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );

  const [activeDragPage, setActiveDragPage] = useState<ICalendarPage | null>(
    null,
  );
  // Mirrors `activeDragPage` for the native listeners that must not zoom or
  // create while a move-drag owns the pointers.
  const dragActiveRef = useRef(false);
  dragActiveRef.current = activeDragPage !== null;
  const [dragDeltaMinutes, setDragDeltaMinutes] = useState(0);
  const dragDeltaMinutesRef = useRef(0);
  const dragDeltaPxRef = useRef(0);
  // The dragged event's start-minute, captured at drag start, so the move can
  // snap the absolute result (start + raw delta) to the grid instead of snapping
  // the delta alone and inheriting an off-grid origin.
  const dragStartMinRef = useRef(0);
  const [dragTargetDay, setDragTargetDay] = useState<Date | null>(null);
  const interactionPointerRef = useRef<{ x: number; y: number } | null>(null);

  // Ctrl/Cmd held during a move-drag turns it into a duplicate: the original
  // stays put and a copy is created at the drop slot. The ref drives the drop
  // decision; the state drives the "copy" affordance on the drop ghost.
  const dragDuplicateRef = useRef(false);
  const [isDuplicateDrag, setIsDuplicateDrag] = useState(false);
  const setDragDuplicate = useCallback((v: boolean) => {
    if (dragDuplicateRef.current !== v) {
      dragDuplicateRef.current = v;
      setIsDuplicateDrag(v);
    }
  }, []);

  // Edge-drag navigation: when dragging near left/right edge, auto-navigate after delay
  const edgeDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edgeDragDirRef = useRef<-1 | 1 | null>(null);
  const edgeDragTransitionCancelRef = useRef<(() => void) | null>(null);
  // Track the target day for day-view edge navigation (accumulated offset from original date)
  const edgeDragTargetDayRef = useRef<Date | null>(null);
  const EDGE_THRESHOLD = 30; // px from edge to trigger
  const EDGE_NAV_DELAY = 1200; // ms before navigating

  const clearEdgeDragTimer = useCallback(() => {
    if (edgeDragTimerRef.current) {
      clearTimeout(edgeDragTimerRef.current);
      edgeDragTimerRef.current = null;
    }
    edgeDragDirRef.current = null;
  }, []);

  // Track which column the pointer is over during drag (for week view cross-day drag)
  // + edge detection for auto-navigation in both views
  useEffect(() => {
    if (!activeDragPage) {
      edgeDragTargetDayRef.current = null;
      return;
    }

    function handlePointerMove(e: PointerEvent) {
      setDragDuplicate(e.ctrlKey || e.metaKey);
      const timeline = timelineRef.current;
      if (!timeline) return;

      // Week view: track which column pointer is over
      if (viewMode === "week" && gridRef.current) {
        const columns =
          gridRef.current.querySelectorAll<HTMLElement>("[data-day-index]");
        for (const col of columns) {
          const rect = col.getBoundingClientRect();
          if (e.clientX >= rect.left && e.clientX < rect.right) {
            const idx = parseInt(col.dataset.dayIndex!, 10);
            setDragTargetDay(weekDays[idx]);
            break;
          }
        }
      }

      // Edge detection for auto-navigation
      const timelineRect = timeline.getBoundingClientRect();
      const distFromLeft = e.clientX - timelineRect.left;
      const distFromRight = timelineRect.right - e.clientX;

      let edgeDir: -1 | 1 | null = null;
      if (distFromLeft < EDGE_THRESHOLD) {
        edgeDir = isRtl ? 1 : -1;
      } else if (distFromRight < EDGE_THRESHOLD) {
        edgeDir = isRtl ? -1 : 1;
      }

      if (edgeDir !== edgeDragDirRef.current) {
        // Direction changed — clear existing timer
        if (edgeDragTimerRef.current) {
          clearTimeout(edgeDragTimerRef.current);
          edgeDragTimerRef.current = null;
        }

        edgeDragDirRef.current = edgeDir;

        if (edgeDir !== null) {
          edgeDragTimerRef.current = setTimeout(() => {
            triggerHaptic("medium");

            // In day view, track the accumulated target day so handleDragEnd
            // knows which day to save the event to
            if (viewMode === "day") {
              const base =
                edgeDragTargetDayRef.current ||
                zonedWallDate(activeDragPage!.scheduledAt);
              const newTarget = new Date(base);
              newTarget.setDate(newTarget.getDate() + edgeDir!);
              edgeDragTargetDayRef.current = newTarget;
              setDragTargetDay(newTarget);
            }

            // Animate to adjacent panel via transform
            const track = swipeTrackRef.current;
            if (track) {
              const pw = track.parentElement!.clientWidth;
              const targetX = edgeDir === -1 ? 0 : -2 * pw;
              track.style.transition = "transform 300ms cubic-bezier(0.2, 0, 0, 1)";
              track.style.transform = `translateX(${targetX}px)`;
              isNavigatingRef.current = true;
              let settled = false;
              const onEnd = () => {
                if (settled) return;
                settled = true;
                track.removeEventListener("transitionend", onEnd);
                edgeDragTransitionCancelRef.current = null;
                setSelectedDate((prev) => {
                  const next = new Date(prev);
                  next.setDate(next.getDate() + (viewMode === "week" ? edgeDir! * 7 : edgeDir!));
                  return next;
                });
              };
              edgeDragTransitionCancelRef.current = () => {
                if (settled) return;
                settled = true;
                track.removeEventListener("transitionend", onEnd);
                track.style.transition = "none";
                track.style.transform = "translateX(-100%)";
                isNavigatingRef.current = false;
                edgeDragTransitionCancelRef.current = null;
              };
              track.addEventListener("transitionend", onEnd);
            } else {
              goToDay(edgeDir!);
            }

            // Reset so it can fire again if still at edge
            edgeDragTimerRef.current = null;
            edgeDragDirRef.current = null;
          }, EDGE_NAV_DELAY);
        }
      }
    }

    // Track the duplicate modifier even when the pointer is stationary — the
    // user may press or release Ctrl/Cmd mid-drag without moving.
    function handleModifierKey(e: KeyboardEvent) {
      setDragDuplicate(e.ctrlKey || e.metaKey);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("keydown", handleModifierKey);
    window.addEventListener("keyup", handleModifierKey);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("keydown", handleModifierKey);
      window.removeEventListener("keyup", handleModifierKey);
      clearEdgeDragTimer();
    };
  }, [activeDragPage, viewMode, weekDays, clearEdgeDragTimer, isRtl, setDragDuplicate]);

  // Turn a raw pixel offset into a minute delta whose result lands on the grid:
  // snap `start + rawDelta` absolutely, then subtract the start so the existing
  // `oldStartMin + delta` consumers (ghost + drop) stay on grid lines even when
  // a zoom has left the event's origin off the current step.
  function snappedDragDeltaMin(rawDeltaPx: number): number {
    const hh = hourHeightRef.current;
    const rawStart = dragStartMinRef.current + (rawDeltaPx / hh) * 60;
    return snapStartMin(rawStart) - dragStartMinRef.current;
  }

  function handleDragStart(event: DragStartEvent) {
    const page = event.active.data.current?.page as ICalendarPage | undefined;
    if (page) {
      triggerHaptic("medium");
      setActiveDragPage(page);
      setDragDeltaMinutes(0);
      dragDeltaMinutesRef.current = 0;
      dragDeltaPxRef.current = 0;
      dragStartMinRef.current = pageToStartMin(page);
      setDragTargetDay(null);
      const ae = event.activatorEvent as
        | {
            clientX?: number;
            clientY?: number;
            ctrlKey?: boolean;
            metaKey?: boolean;
          }
        | undefined;
      if (typeof ae?.clientX === "number" && typeof ae.clientY === "number") {
        interactionPointerRef.current = { x: ae.clientX, y: ae.clientY };
      }
      setDragDuplicate(!!ae && (!!ae.ctrlKey || !!ae.metaKey));
    }
  }

  function handleDragMove(event: { delta: { y: number } }) {
    dragDeltaPxRef.current = event.delta.y;
    const deltaMinutes = snappedDragDeltaMin(event.delta.y);
    dragDeltaMinutesRef.current = deltaMinutes;
    setDragDeltaMinutes(deltaMinutes);
  }

  function handleDragEnd(_event: DragEndEvent) {
    clearEdgeDragTimer();
    edgeDragTargetDayRef.current = null;
    if (activeDragPage) {
      const oldStartMin = pageToStartMin(activeDragPage);
      let newStartMin = oldStartMin + dragDeltaMinutesRef.current;
      newStartMin = Math.max(
        0,
        Math.min(newStartMin, TOTAL_HOURS * 60 - SNAP_MINUTES),
      );

      const targetDate =
        dragTargetDay || zonedWallDate(activeDragPage.scheduledAt);
      const scheduledDate = new Date(targetDate);
      scheduledDate.setHours(0, 0, 0, 0);
      scheduledDate.setMinutes(newStartMin);

      const newISO = wallDateToUtcIso(scheduledDate);
      // Ctrl/Cmd-drag duplicates instead of moving: the original keeps its slot
      // and a copy lands where the drag ended. Drafts (unsaved) can't be
      // duplicated, so they fall through to the move behavior.
      if (dragDuplicateRef.current && activeDragPage.id !== "__draft__") {
        void duplicatePage(activeDragPage.id, { scheduledAt: newISO });
      } else if (newISO !== activeDragPage.scheduledAt) {
        if (activeDragPage.id === "__draft__") {
          setDraftEvent((prev) =>
            prev ? { ...prev, scheduledAt: newISO } : prev,
          );
        } else {
          updatePage({
            id: activeDragPage.id,
            scheduledAt: newISO,
          });
        }
      }
    }
    setActiveDragPage(null);
    setDragDeltaMinutes(0);
    dragDeltaMinutesRef.current = 0;
    dragDeltaPxRef.current = 0;
    interactionPointerRef.current = null;
    setDragTargetDay(null);
    setDragDuplicate(false);
  }

  function handleDragCancel() {
    clearEdgeDragTimer();
    edgeDragTransitionCancelRef.current?.();
    edgeDragTargetDayRef.current = null;
    setActiveDragPage(null);
    setDragDeltaMinutes(0);
    dragDeltaMinutesRef.current = 0;
    dragDeltaPxRef.current = 0;
    interactionPointerRef.current = null;
    setDragTargetDay(null);
    setDragDuplicate(false);
  }

  // ── Resize (bottom handle drag) ──
  const [resize, setResize] = useState<ResizeState | null>(null);
  const [resizeDuration, setResizeDuration] = useState<number | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const resizeDurationRef = useRef<number | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  function handleResizeStart(pageId: string, e: React.PointerEvent) {
    const page = timedPages.find((p) => p.id === pageId);
    if (!page) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    triggerHaptic("light");

    const state: ResizeState = {
      pageId,
      originalDuration: page.duration || 60,
      originalStartMin: pageToStartMin(page),
      startY: e.clientY,
      startScrollTop: timelineRef.current?.scrollTop ?? 0,
    };
    const dur = page.duration || 60;

    resizeRef.current = state;
    resizeDurationRef.current = dur;
    setResize(state);
    setResizeDuration(dur);
    interactionPointerRef.current = { x: e.clientX, y: e.clientY };

    // Clean up any previous listeners
    resizeCleanupRef.current?.();

    const timeline = timelineRef.current;
    const preventScroll = (ev: TouchEvent) => ev.preventDefault();
    if (timeline) {
      timeline.addEventListener("touchmove", preventScroll, { passive: false });
    }

    function handlePointerMove(ev: PointerEvent) {
      const r = resizeRef.current;
      if (!r) return;
      const scrollDelta =
        (timelineRef.current?.scrollTop ?? r.startScrollTop) -
        r.startScrollTop;
      const deltaPx = snapPx(
        ev.clientY - r.startY + scrollDelta,
        hourHeightRef.current,
      );
      const deltaMin = pxToMinutes(deltaPx, hourHeightRef.current);
      const newDuration = Math.max(
        MIN_DRAG_MINUTES,
        r.originalDuration + deltaMin,
      );
      const maxDuration = TOTAL_HOURS * 60 - r.originalStartMin;
      const clamped = Math.min(newDuration, maxDuration);
      resizeDurationRef.current = clamped;
      setResizeDuration(clamped);
    }

    function handlePointerUp() {
      const r = resizeRef.current;
      const d = resizeDurationRef.current;
      if (r && d !== null && d !== r.originalDuration) {
        if (r.pageId === "__draft__") {
          setDraftEvent((prev) => (prev ? { ...prev, duration: d } : prev));
        } else {
          updatePage({ id: r.pageId, duration: d });
        }
      }
      resetResize();
    }

    function resetResize() {
      resizeRef.current = null;
      resizeDurationRef.current = null;
      setResize(null);
      setResizeDuration(null);
      interactionPointerRef.current = null;
      cleanup();
    }

    function handlePointerCancel() {
      resetResize();
    }

    function handleKeyDown(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      resetResize();
    }

    function cleanup() {
      if (timeline) {
        timeline.removeEventListener("touchmove", preventScroll);
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("keydown", handleKeyDown, true);
      resizeCleanupRef.current = null;
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("keydown", handleKeyDown, true);
    resizeCleanupRef.current = cleanup;
  }

  // ── Click-and-drag to create ──
  const [createDrag, setCreateDrag] = useState<CreateDragState | null>(null);
  const isCreateDragging = useRef(false);

  function getColumnDateFromMouseEvent(e: React.MouseEvent): Date {
    if (viewMode === "week") {
      const target = (e.target as HTMLElement).closest(
        `[data-day-index]`,
      ) as HTMLElement | null;
      if (target) {
        const idx = parseInt(target.dataset.dayIndex!, 10);
        return weekDays[idx];
      }
    }
    return selectedDate;
  }

  function getColumnDateFromElement(el: HTMLElement): Date {
    if (viewMode === "week") {
      const target = el.closest(`[data-day-index]`) as HTMLElement | null;
      if (target) {
        const idx = parseInt(target.dataset.dayIndex!, 10);
        return weekDays[idx];
      }
    }
    return selectedDate;
  }

  function handleGridMouseDown(e: React.MouseEvent) {
    if (
      (!sidebarMode && (previewPageId || draftEvent)) ||
      previewJustClosedRef.current
    )
      return;
    if ((e.target as HTMLElement).closest(`.${style.eventCard}`)) return;
    if ((e.target as HTMLElement).closest(`.${style.resizeHandle}`)) return;
    e.preventDefault();

    const date = getColumnDateFromMouseEvent(e);
    const columnEl =
      viewMode === "week"
        ? ((e.target as HTMLElement).closest(
            `[data-day-index]`,
          ) as HTMLElement | null)
        : null;
    const el = columnEl || gridRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const minutes = Math.max(
      0,
      Math.min(
        pxToMinutes(y, hourHeightRef.current),
        TOTAL_HOURS * 60 - SNAP_MINUTES,
      ),
    );

    isCreateDragging.current = true;
    interactionPointerRef.current = { x: e.clientX, y: e.clientY };
    setCreateDrag({
      startMinutes: minutes,
      endMinutes: Math.min(
        minutes + minCreateMinutes(hourHeightRef.current),
        TOTAL_HOURS * 60,
      ),
      date,
    });
  }

  useEffect(() => {
    if (!isCreateDragging.current) return;

    function handleMouseMove(e: MouseEvent) {
      if (!isCreateDragging.current) return;
      interactionPointerRef.current = { x: e.clientX, y: e.clientY };
      const el = gridRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.max(
        0,
        Math.min(
          pxToMinutes(y, hourHeightRef.current),
          TOTAL_HOURS * 60 - SNAP_MINUTES,
        ),
      );

      setCreateDrag((prev) => {
        if (!prev) return prev;
        const endMin = Math.max(
          prev.startMinutes + minCreateMinutes(hourHeightRef.current),
          minutes + SNAP_MINUTES,
        );
        return {
          ...prev,
          endMinutes: Math.min(endMin, TOTAL_HOURS * 60),
        };
      });
    }

    function handleMouseUp() {
      if (!isCreateDragging.current) return;
      isCreateDragging.current = false;
      interactionPointerRef.current = null;
      setCreateDrag((prev) => {
        if (prev) {
          const duration = prev.endMinutes - prev.startMinutes;
          createPageAtTime(prev.startMinutes, duration, prev.date);
        }
        return null;
      });
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [createDrag !== null, createPageAtTime]);

  // ── Touch long-press to create (Google Calendar style) ──
  const touchCreateRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    startX: number;
    startY: number;
    targetEl: HTMLElement;
    scrollTop: number;
    active: boolean;
    startMinutes?: number;
  } | null>(null);

  useEffect(() => {
    if (!createDrag) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      isCreateDragging.current = false;
      const touchCreate = touchCreateRef.current;
      if (touchCreate) clearTimeout(touchCreate.timer);
      touchCreateRef.current = null;
      interactionPointerRef.current = null;
      setCreateDrag(null);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [createDrag !== null]);

  const LONG_PRESS_MS = 400;
  const LONG_PRESS_MOVE_TOLERANCE = 10;

  // Compute minutes from a clientY position relative to the grid
  const getMinutesFromClientY = useCallback((clientY: number): number => {
    const columnEl = touchCreateRef.current?.targetEl.closest(
      `[data-day-index]`,
    ) as HTMLElement | null;
    const el = columnEl || gridRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top;
    return Math.max(
      0,
      Math.min(
        pxToMinutes(y, hourHeightRef.current),
        TOTAL_HOURS * 60 - SNAP_MINUTES,
      ),
    );
  }, []);

  const handleGridTouchStart = useCallback(
    (e: React.TouchEvent) => {
      // Don't start create-drag if preview/draft is open, or if touching an event card
      if (
        (!sidebarMode && (previewPageId || draftEvent)) ||
        previewJustClosedRef.current
      )
        return;
      // A second finger belongs to the zoom gesture, not to creation.
      if (e.touches.length > 1 || pinchRef.current) return;
      const target = e.target as HTMLElement;
      if (target.closest(`.${style.eventCard}`)) return;
      if (target.closest(`.${style.resizeHandle}`)) return;

      const touch = e.touches[0];
      const scrollTop = timelineRef.current?.scrollTop ?? 0;

      const timer = setTimeout(() => {
        const state = touchCreateRef.current;
        if (!state) return;

        // Native scrolling can advance between the last touchmove and this
        // timer. Scrolling wins over creation whenever the viewport moved.
        const currentScrollTop = timelineRef.current?.scrollTop ?? 0;
        if (Math.abs(currentScrollTop - state.scrollTop) > 5) {
          touchCreateRef.current = null;
          return;
        }

        // Activate create mode
        state.active = true;

        // Haptic feedback (native bridge on iOS/Android, Vibration API fallback)
        triggerHaptic("medium");

        const date = getColumnDateFromElement(state.targetEl);
        const minutes = getMinutesFromClientY(state.startY);
        state.startMinutes = minutes;
        interactionPointerRef.current = {
          x: state.startX,
          y: state.startY,
        };

        setCreateDrag({
          startMinutes: minutes,
          endMinutes: Math.min(
            minutes + minCreateMinutes(hourHeightRef.current),
            TOTAL_HOURS * 60,
          ),
          date,
        });
      }, LONG_PRESS_MS);

      touchCreateRef.current = {
        timer,
        startX: touch.clientX,
        startY: touch.clientY,
        targetEl: target,
        scrollTop,
        active: false,
      };
    },
    [
      sidebarMode,
      previewPageId,
      draftEvent,
      getMinutesFromClientY,
      viewMode,
      weekDays,
    ],
  );

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;

    function cancelTouchCreateOnScroll() {
      const state = touchCreateRef.current;
      if (!state) return;

      clearTimeout(state.timer);
      if (state.active) return;
      touchCreateRef.current = null;
    }

    timeline.addEventListener("scroll", cancelTouchCreateOnScroll, {
      passive: true,
    });
    return () =>
      timeline.removeEventListener("scroll", cancelTouchCreateOnScroll);
  }, []);

  // Native touchmove handler for create-drag (needs passive: false to preventDefault)
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;

    function onTouchMoveCreate(e: TouchEvent) {
      const state = touchCreateRef.current;
      if (!state) return;

      const touch = e.touches[0];
      interactionPointerRef.current = {
        x: touch.clientX,
        y: touch.clientY,
      };

      if (!state.active) {
        // Before long-press fires: cancel if finger moves too much or if scroll changed
        const dx = Math.abs(touch.clientX - state.startX);
        const dy = Math.abs(touch.clientY - state.startY);
        const scrollDelta = Math.abs(
          (timelineRef.current?.scrollTop ?? 0) - state.scrollTop,
        );
        if (
          dx > LONG_PRESS_MOVE_TOLERANCE ||
          dy > LONG_PRESS_MOVE_TOLERANCE ||
          scrollDelta > 5
        ) {
          clearTimeout(state.timer);
          touchCreateRef.current = null;
        }
        return;
      }

      // Active create-drag: prevent scroll and update preview
      e.preventDefault();

      const startMinutes =
        state.startMinutes ?? getMinutesFromClientY(state.startY);
      const currentMinutes = getMinutesFromClientY(touch.clientY);

      setCreateDrag((prev) => {
        if (!prev) return prev;
        // Allow dragging both up and down from start point
        const minMin = Math.min(startMinutes, currentMinutes);
        const maxMin = Math.max(startMinutes, currentMinutes) + SNAP_MINUTES;
        return {
          ...prev,
          startMinutes: minMin,
          endMinutes: Math.min(
            Math.max(maxMin, minMin + minCreateMinutes(hourHeightRef.current)),
            TOTAL_HOURS * 60,
          ),
        };
      });
    }

    el.addEventListener("touchmove", onTouchMoveCreate, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMoveCreate);
  }, [getMinutesFromClientY, viewMode]);

  const handleGridTouchEnd = useCallback(
    (e?: React.TouchEvent) => {
      const state = touchCreateRef.current;
      if (!state) return;

      clearTimeout(state.timer);

      if (state.active) {
        // Cancel the compatibility mouse events iOS synthesizes ~300ms after
        // touchend at the release point. The new-event draft sheet slides up
        // from the bottom exactly where this create gesture ends, so that ghost
        // click would land on the sheet's title canvas and focus it — flashing
        // the keyboard (and, under Keyboard `resize: "native"`, briefly resizing
        // the WebView, which reflows the sheet's contents) the instant the draft
        // opens. Mobile deliberately does NOT auto-focus the title, so this
        // phantom focus is pure flicker. The gesture is fully handled here;
        // nothing downstream needs the synthetic click. (touchcancel isn't
        // cancelable, hence the `cancelable` guard.)
        if (e?.cancelable) e.preventDefault();
        // Finalize the create-drag
        setCreateDrag((prev) => {
          if (prev) {
            const duration = prev.endMinutes - prev.startMinutes;
            createPageAtTime(prev.startMinutes, duration, prev.date);
          }
          return null;
        });
      }

      touchCreateRef.current = null;
      interactionPointerRef.current = null;
    },
    [createPageAtTime],
  );

  // Keep every vertical calendar interaction moving when the pointer reaches a
  // timeline edge. The interaction calculations are refreshed from the actual
  // scroll position, so create, resize, and move stay attached to grid time.
  useEffect(() => {
    const interactionActive =
      activeDragPage !== null || resize !== null || createDrag !== null;
    if (!interactionActive) return;

    let frame = 0;

    function trackPointer(e: PointerEvent) {
      interactionPointerRef.current = { x: e.clientX, y: e.clientY };
    }

    function trackTouch(e: TouchEvent) {
      const touch = e.touches[0];
      if (touch) {
        interactionPointerRef.current = {
          x: touch.clientX,
          y: touch.clientY,
        };
      }
    }

    function updateCreateAtPointer(clientY: number) {
      const touchState = touchCreateRef.current;
      const columnEl = touchState?.targetEl.closest(
        `[data-day-index]`,
      ) as HTMLElement | null;
      const el = columnEl || gridRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const currentMinutes = Math.max(
        0,
        Math.min(
          pxToMinutes(clientY - rect.top, hourHeightRef.current),
          TOTAL_HOURS * 60 - SNAP_MINUTES,
        ),
      );

      setCreateDrag((prev) => {
        if (!prev) return prev;
        const minCreate = minCreateMinutes(hourHeightRef.current);
        if (touchState?.active) {
          const startMinutes = touchState.startMinutes ?? prev.startMinutes;
          const minMin = Math.min(startMinutes, currentMinutes);
          const maxMin = Math.max(startMinutes, currentMinutes) + SNAP_MINUTES;
          return {
            ...prev,
            startMinutes: minMin,
            endMinutes: Math.min(
              Math.max(maxMin, minMin + minCreate),
              TOTAL_HOURS * 60,
            ),
          };
        }

        if (!isCreateDragging.current) return prev;
        const endMinutes = Math.max(
          prev.startMinutes + minCreate,
          currentMinutes + SNAP_MINUTES,
        );
        return {
          ...prev,
          endMinutes: Math.min(endMinutes, TOTAL_HOURS * 60),
        };
      });
    }

    function tick() {
      const timeline = timelineRef.current;
      const pointer = interactionPointerRef.current;
      if (timeline && pointer) {
        const rect = timeline.getBoundingClientRect();
        const edgeSize = Math.min(80, rect.height / 3);
        let speed = 0;

        if (pointer.x >= rect.left && pointer.x <= rect.right) {
          if (pointer.y < rect.top + edgeSize) {
            speed =
              -20 *
              Math.min(1, (rect.top + edgeSize - pointer.y) / edgeSize);
          } else if (pointer.y > rect.bottom - edgeSize) {
            speed =
              20 *
              Math.min(
                1,
                (pointer.y - (rect.bottom - edgeSize)) / edgeSize,
              );
          }
        }

        if (speed !== 0) {
          const before = timeline.scrollTop;
          timeline.scrollTop += speed;
          const scrollDelta = timeline.scrollTop - before;

          if (scrollDelta !== 0) {
            if (activeDragPage) {
              dragDeltaPxRef.current += scrollDelta;
              const minutes = snappedDragDeltaMin(dragDeltaPxRef.current);
              dragDeltaMinutesRef.current = minutes;
              setDragDeltaMinutes(minutes);
            } else if (resizeRef.current) {
              const r = resizeRef.current;
              const totalScrollDelta = timeline.scrollTop - r.startScrollTop;
              const deltaMin = pxToMinutes(
                snapPx(
                  pointer.y - r.startY + totalScrollDelta,
                  hourHeightRef.current,
                ),
                hourHeightRef.current,
              );
              const duration = Math.min(
                Math.max(MIN_DRAG_MINUTES, r.originalDuration + deltaMin),
                TOTAL_HOURS * 60 - r.originalStartMin,
              );
              resizeDurationRef.current = duration;
              setResizeDuration(duration);
            } else if (createDrag) {
              updateCreateAtPointer(pointer.y);
            }
          }
        }
      }

      frame = requestAnimationFrame(tick);
    }

    window.addEventListener("pointermove", trackPointer);
    window.addEventListener("touchmove", trackTouch, { passive: true });
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", trackPointer);
      window.removeEventListener("touchmove", trackTouch);
    };
  }, [activeDragPage !== null, resize !== null, createDrag !== null]);

  // ── Swipe navigation (manual touch + transform) ──
  const swipeTrackRef = useRef<HTMLDivElement>(null);
  const isNavigatingRef = useRef(false);
  const swipeTouchRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const swipeDirRef = useRef<"x" | "y" | null>(null);
  const swipeOffsetRef = useRef(0);

  // Reset to center panel before paint
  useLayoutEffect(() => {
    const track = swipeTrackRef.current;
    if (!track) return;
    track.style.transition = "none";
    track.style.transform = `translateX(-100%)`;
    swipeOffsetRef.current = 0;
    requestAnimationFrame(() => {
      isNavigatingRef.current = false;
    });
  }, [selectedDate, viewMode]);

  const handleSwipeTouchStart = useCallback((e: React.TouchEvent) => {
    if (isNavigatingRef.current) return;
    if (e.touches.length > 1 || pinchRef.current) return;
    const touch = e.touches[0];
    swipeTouchRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    swipeDirRef.current = null;
    const track = swipeTrackRef.current;
    if (track) track.style.transition = "none";
  }, []);

  // Register touchmove natively with { passive: false } so preventDefault() works
  useEffect(() => {
    const track = swipeTrackRef.current;
    if (!track) return;
    const strip = track.parentElement!;

    function onTouchMove(e: TouchEvent) {
      // Week view has 7 narrow columns where a horizontal drag reads as an
      // accidental gesture; don't pan the whole grid between weeks there (use
      // the header arrows instead). Day view keeps day-to-day swiping.
      if (viewMode === "week") return;
      if (pinchRef.current || e.touches.length > 1) return;
      const start = swipeTouchRef.current;
      if (!start) return;
      const touch = e.touches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;

      if (!swipeDirRef.current) {
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
          swipeDirRef.current = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        }
        return;
      }

      if (swipeDirRef.current === "y") return;

      e.preventDefault();
      swipeOffsetRef.current = dx;
      const pw = strip.clientWidth;
      track!.style.transform = `translateX(${-pw + dx}px)`;
    }

    strip.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => strip.removeEventListener("touchmove", onTouchMove);
  }, [viewMode]);

  const handleSwipeTouchEnd = useCallback(() => {
    const start = swipeTouchRef.current;
    swipeTouchRef.current = null;
    if (!start || swipeDirRef.current !== "x") {
      swipeDirRef.current = null;
      return;
    }

    const track = swipeTrackRef.current;
    if (!track) return;

    const pw = track.parentElement!.clientWidth;
    const dx = swipeOffsetRef.current;
    const dt = Date.now() - start.time;
    const velocity = Math.abs(dx) / dt; // px/ms

    const VELOCITY_THRESHOLD = 0.3;
    const DISTANCE_THRESHOLD = pw * 0.25;

    let target: -1 | 0 | 1 = 0;
    if (dx > 0 && (velocity > VELOCITY_THRESHOLD || dx > DISTANCE_THRESHOLD)) {
      target = -1; // swiped right → prev
    } else if (dx < 0 && (velocity > VELOCITY_THRESHOLD || -dx > DISTANCE_THRESHOLD)) {
      target = 1; // swiped left → next
    }

    swipeOffsetRef.current = 0;
    swipeDirRef.current = null;

    // Settle the track to a panel: prev → translateX(0), center → translateX(-pw),
    // next → translateX(-2pw).
    const animateTo = (t: -1 | 0 | 1) => {
      const targetX = -pw - t * pw;
      const remainingDist = Math.abs(targetX - (-pw + dx));
      const duration =
        t === 0
          ? Math.min(250, Math.max(120, remainingDist * 0.8))
          : Math.min(300, Math.max(150, remainingDist / Math.max(velocity, 0.5)));
      track.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0, 1)`;
      track.style.transform = `translateX(${targetX}px)`;
    };

    if (target === 0) {
      animateTo(0);
      return;
    }

    // A navigation would occur — guard an in-progress draft before committing.
    // On "keep editing" snap back to center so we don't strand a half-swipe.
    guardDiscard(
      () => {
        animateTo(target);
        const onEnd = () => {
          track.removeEventListener("transitionend", onEnd);
          isNavigatingRef.current = true;
          setSelectedDate((prev) => {
            const next = new Date(prev);
            const delta =
              target === -1
                ? viewMode === "week"
                  ? -7
                  : -1
                : viewMode === "week"
                  ? 7
                  : 1;
            next.setDate(next.getDate() + delta);
            return next;
          });
        };
        track.addEventListener("transitionend", onEnd);
      },
      () => animateTo(0),
    );
  }, [viewMode, guardDiscard]);

  // ── Zoom the hour scale (two-finger pinch, ⌘/Ctrl + wheel) ──

  // Re-anchor the timeline after a zoom so the time the gesture grabbed stays
  // under the fingers (or cursor) instead of the day sliding away.
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    zoomAnchorRef.current = null;
    const timeline = timelineRef.current;
    if (!anchor || !timeline) return;
    timeline.scrollTop = Math.max(
      0,
      anchor.gridOffset + anchor.anchorHours * hourHeight - anchor.viewportY,
    );
  }, [hourHeight]);

  // Cancel a pending/active long-press create: a second finger means zoom.
  const cancelTouchCreate = useCallback(() => {
    const state = touchCreateRef.current;
    if (state) clearTimeout(state.timer);
    touchCreateRef.current = null;
    isCreateDragging.current = false;
    interactionPointerRef.current = null;
    setCreateDrag(null);
  }, []);

  const persistHourHeight = useCallback(
    (value: number) => {
      setStoredHourHeight(Math.round(value));
    },
    [setStoredHourHeight],
  );

  useEffect(() => {
    const maybeTimeline = timelineRef.current;
    if (!maybeTimeline) return;
    const timeline: HTMLDivElement = maybeTimeline;

    const touchDistance = (a: Touch, b: Touch) =>
      Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    // Where hour 0 sits in the scroll content, and which hour a client Y is on.
    function measure(clientY: number) {
      const grid = gridRef.current;
      if (!grid) return null;
      const timelineRect = timeline.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      return {
        gridOffset: gridRect.top - timelineRect.top + timeline.scrollTop,
        anchorHours: Math.min(
          TOTAL_HOURS,
          Math.max(0, (clientY - gridRect.top) / hourHeightRef.current),
        ),
        viewportY: clientY - timelineRect.top,
      };
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 2 || dragActiveRef.current || resizeRef.current)
        return;
      const [a, b] = [e.touches[0], e.touches[1]];
      const startDistance = touchDistance(a, b);
      if (startDistance < 1) return;
      const anchor = measure((a.clientY + b.clientY) / 2);
      if (!anchor) return;

      pinchRef.current = {
        startDistance,
        startHourHeight: hourHeightRef.current,
        anchorHours: anchor.anchorHours,
        gridOffset: anchor.gridOffset,
      };
      // The single-touch gestures this interrupts must not resume on release.
      cancelTouchCreate();
      swipeTouchRef.current = null;
      swipeDirRef.current = null;
    }

    function onTouchMove(e: TouchEvent) {
      const pinch = pinchRef.current;
      if (!pinch || e.touches.length < 2) return;
      if (e.cancelable) e.preventDefault();

      const [a, b] = [e.touches[0], e.touches[1]];
      const distance = touchDistance(a, b);
      if (distance < 1) return;
      const midY = (a.clientY + b.clientY) / 2;

      zoomAnchorRef.current = {
        gridOffset: pinch.gridOffset,
        anchorHours: pinch.anchorHours,
        viewportY: midY - timeline.getBoundingClientRect().top,
      };
      setHourHeight(
        clampHourHeight(
          pinch.startHourHeight * (distance / pinch.startDistance),
        ),
      );
    }

    function onTouchEnd(e: TouchEvent) {
      if (!pinchRef.current || e.touches.length >= 2) return;
      pinchRef.current = null;
      const settled = Math.round(hourHeightRef.current);
      setHourHeight(settled);
      persistHourHeight(settled);
    }

    // Trackpad pinch arrives as a ctrl-wheel; ⌘ covers the explicit shortcut.
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const anchor = measure(e.clientY);
      if (anchor) zoomAnchorRef.current = anchor;
      // Normalize the wheel delta: a trackpad reports pixels (fine-grained), but
      // a physical mouse reports lines (~±3/notch) or pages, which would barely
      // move the scale. Scale line/page steps up so a mouse notch zooms visibly.
      const step =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? e.deltaY * 16
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? e.deltaY * 400
            : e.deltaY;
      const next = clampHourHeight(
        hourHeightRef.current * Math.exp(-step / 180),
      );
      setHourHeight(next);
      if (zoomPersistTimerRef.current) {
        clearTimeout(zoomPersistTimerRef.current);
      }
      zoomPersistTimerRef.current = setTimeout(() => {
        zoomPersistTimerRef.current = null;
        persistHourHeight(hourHeightRef.current);
      }, 400);
    }

    timeline.addEventListener("touchstart", onTouchStart, { passive: true });
    timeline.addEventListener("touchmove", onTouchMove, { passive: false });
    timeline.addEventListener("touchend", onTouchEnd);
    timeline.addEventListener("touchcancel", onTouchEnd);
    timeline.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      timeline.removeEventListener("touchstart", onTouchStart);
      timeline.removeEventListener("touchmove", onTouchMove);
      timeline.removeEventListener("touchend", onTouchEnd);
      timeline.removeEventListener("touchcancel", onTouchEnd);
      timeline.removeEventListener("wheel", onWheel);
    };
  }, [cancelTouchCreate, persistHourHeight, viewMode]);

  useEffect(
    () => () => {
      if (zoomPersistTimerRef.current) {
        clearTimeout(zoomPersistTimerRef.current);
      }
    },
    [],
  );

  // ── Now indicator ──
  const [nowMinutes, setNowMinutes] = useState(() => {
    const now = wallNow();
    return now.getHours() * 60 + now.getMinutes();
  });

  useEffect(() => {
    const interval = setInterval(() => {
      const now = wallNow();
      setNowMinutes(now.getHours() * 60 + now.getMinutes());
      // Roll the reference "today" over when the wall clock crosses midnight
      setToday((prev) => (isSameDay(prev, now) ? prev : now));
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        previewPageId ||
        draftEvent
      )
        return;

      switch (e.key) {
        case "p":
          e.preventDefault();
          goToDay(-1);
          break;
        case "n":
          e.preventDefault();
          goToDay(1);
          break;
        case "t":
          e.preventDefault();
          goToToday();
          break;
        case "c": {
          e.preventDefault();
          // Land where the user is looking: the next quarter-hour when today is
          // on screen, the start of the working day otherwise. The draft opens
          // with the title focused, so a whole event is "c", type, ⌘↵ — no
          // pointer, and no drag to place a card the fields can restate.
          const start = isToday
            ? Math.ceil(nowMinutes / SNAP_MINUTES) * SNAP_MINUTES
            : KEYBOARD_CREATE_START_MINUTES;
          createPageAtTime(
            Math.min(start, TOTAL_HOURS * 60 - KEYBOARD_CREATE_MINUTES),
            KEYBOARD_CREATE_MINUTES,
          );
          break;
        }
        case "1":
          e.preventDefault();
          setViewMode("day");
          break;
        case "2":
          e.preventDefault();
          setViewMode("week");
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    createPageAtTime,
    viewMode,
    previewPageId,
    draftEvent,
    isToday,
    nowMinutes,
  ]);

  const noopHandler = useCallback(() => {}, []);

  // ── Render helpers ──

  function renderHourLines() {
    return Array.from({ length: TOTAL_HOURS }, (_, hour) => (
      <div
        key={hour}
        className={style.hourLine}
        style={{ top: hour * hourHeight }}
      >
        {viewMode === "day" && hour % labelStep === 0 && (
          <span className={style.timeLabel}>{formatHour(hour)}</span>
        )}
      </div>
    ));
  }

  function renderDayColumn(
    dayDate: Date,
    dayPages: ICalendarPage[],
    columnIndex?: number,
  ) {
    const isDayToday = isSameDay(dayDate, today);

    return (
      <div
        key={columnIndex ?? 0}
        className={style.weekColumn}
        data-day-index={columnIndex}
        style={{ position: "relative", height: TOTAL_HOURS * hourHeight }}
      >
        {getLaidOutPages(dayPages, dayDate).map(({ page, layout }) => (
          <EventCard
            key={page.id}
            page={page}
            layout={layout}
            hourHeight={hourHeight}
            onResizeStart={handleResizeStart}
            onEventClick={handleEventClick}
            onDuplicate={(id) => duplicatePage(id, { select: true })}
            onDelete={handleEventDelete}
            compact={viewMode === "week"}
            isDraft={page.id === "__draft__"}
          />
        ))}

        {/* Move-drag ghost */}
        {activeDragPage &&
          (() => {
            const ghostDay =
              dragTargetDay || zonedWallDate(activeDragPage.scheduledAt);
            if (!isSameDay(ghostDay, dayDate)) return null;
            const oldStartMin = pageToStartMin(activeDragPage);
            const duration = activeDragPage.duration || 60;
            let newStartMin = oldStartMin + dragDeltaMinutes;
            newStartMin = Math.max(
              0,
              Math.min(newStartMin, TOTAL_HOURS * 60 - SNAP_MINUTES),
            );
            const top = (newStartMin / 60) * hourHeight;
            const height = (duration / 60) * hourHeight;
            const layout = getTransientLayout(
              dayDate,
              {
                id: "__drag_ghost__",
                startMinutes: newStartMin,
                duration,
              },
              activeDragPage.id,
            );

            const duplicating =
              isDuplicateDrag && activeDragPage.id !== "__draft__";

            return (
              <div
                className={style.dropGhost}
                style={{
                  top,
                  height,
                  ...getEventLaneInsets(layout, true),
                }}
              >
                <span
                  className={clsx(
                    style.dropGhostTime,
                    height < 18 && style.dropGhostTimeBelow,
                  )}
                >
                  {formatTimeRange(newStartMin, newStartMin + duration)}
                </span>
                {duplicating && (
                  <span className={style.dropGhostBadge}>
                    {t("calendar.copy", "Copy")}
                  </span>
                )}
              </div>
            );
          })()}

        {/* Create-drag preview */}
        {createDrag && isSameDay(createDrag.date, dayDate) && (
          <div
            className={style.dragPreview}
            style={{
              top: (createDrag.startMinutes / 60) * hourHeight,
              height:
                ((createDrag.endMinutes - createDrag.startMinutes) / 60) *
                hourHeight,
              ...getEventLaneInsets(
                getTransientLayout(dayDate, {
                  id: "__create_ghost__",
                  startMinutes: createDrag.startMinutes,
                  duration: createDrag.endMinutes - createDrag.startMinutes,
                }),
                true,
              ),
            }}
          >
            <span className={style.dragPreviewTime}>
              {formatTimeRange(createDrag.startMinutes, createDrag.endMinutes)}
            </span>
          </div>
        )}

        {/* Now indicator */}
        {isDayToday && (
          <>
            {viewMode === "week" && (
              <div
                className={style.nowIndicatorDot}
                style={{
                  top: (nowMinutes / 60) * hourHeight,
                  insetInlineStart: -4,
                  width: 8,
                  height: 8,
                }}
              />
            )}
            <div
              className={style.nowIndicator}
              style={{ top: (nowMinutes / 60) * hourHeight, insetInlineStart: 0 }}
            />
          </>
        )}
      </div>
    );
  }

  function renderWeekPanel(days: Date[], isCenter: boolean) {
    return (
      <div
        ref={isCenter ? gridRef : undefined}
        className={style.weekGrid}
        style={{ height: TOTAL_HOURS * hourHeight }}
        onMouseDown={isCenter ? handleGridMouseDown : undefined}
        onTouchStart={isCenter ? handleGridTouchStart : undefined}
        onTouchEnd={isCenter ? handleGridTouchEnd : undefined}
        onTouchCancel={isCenter ? handleGridTouchEnd : undefined}
      >
        <div className={style.weekTimeLabels}>
          {Array.from({ length: TOTAL_HOURS }, (_, hour) =>
            hour % labelStep === 0 ? (
              <div
                key={hour}
                className={style.weekTimeLabel}
                style={{ top: hour * hourHeight }}
              >
                {formatHour(hour)}
              </div>
            ) : null,
          )}
        </div>
        {days.map((day, i) => {
          let dayPages = getPagesForDay(day);
          if (!isCenter && activeDragPage) {
            dayPages = dayPages.filter((p) => p.id !== activeDragPage.id);
          }
          return (
            <div
              key={i}
              className={style.weekColumnWrapper}
              data-day-index={isCenter ? i : undefined}
            >
              {Array.from({ length: TOTAL_HOURS }, (_, hour) => (
                <div
                  key={hour}
                  className={style.weekHourLine}
                  style={{ top: hour * hourHeight }}
                />
              ))}
              {renderDayColumn(day, dayPages, isCenter ? i : undefined)}
            </div>
          );
        })}
        {/* Keep dragged EventCard mounted during edge-drag navigation */}
        {/* {isCenter &&
          activeDragPage &&
          !days.some((day) =>
            getPagesForDay(day).some((p) => p.id === activeDragPage!.id),
          ) && (
            <EventCard
              key={activeDragPage.id}
              page={activeDragPage}
              onResizeStart={noopHandler}
              onEventClick={noopHandler}
              compact
              isDraft={activeDragPage.id === "__draft__"}
            />
          )} */}
      </div>
    );
  }

  return (
    <div className={style.container}>
      <TopActionBarPortal>
        <div className={style.headerNav}>
          <button
            className={style.headerNavButton}
            onClick={() => goToDay(-1)}
          >
            {isRtl ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
          <button className={style.todayButton} onClick={goToToday}>
            {t("common.today", "Today")}
          </button>
          <button
            className={style.headerNavButton}
            onClick={() => goToDay(1)}
          >
            {isRtl ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
          </button>
        </div>
        <span
          className={clsx(style.headerTitle, style.headerTitleDesktop)}
          data-window-drag
        >
          {viewMode === "day"
            ? formatDate(selectedDate)
            : formatWeekRange(selectedDate)}
        </span>
        <button
          className={clsx(
            style.headerTitle,
            style.headerTitleMobile,
            style.miniCalTrigger,
          )}
          onClick={() => setMiniCalOpen(true)}
        >
          {formatMonthLong(selectedDate)}
          <ChevronDown size={14} />
        </button>
        <button
          className={clsx(style.todayButtonMobile, "ms-auto")}
          onClick={goToToday}
          aria-label={t("common.today", "Today")}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="3" y1="10" x2="21" y2="10" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <text
              x="12"
              y="19"
              textAnchor="middle"
              stroke="none"
              fill="currentColor"
              fontSize="8"
              fontWeight="700"
            >
              {wallNow().getDate()}
            </text>
          </svg>
        </button>
        <DateTimePickerOverlay
          open={miniCalOpen}
          onClose={() => setMiniCalOpen(false)}
          selectedYear={overlayYear}
          selectedMonth={overlayMonth}
          selectedDay={overlayDay}
          setSelectedYear={setOverlayYear}
          setSelectedMonth={setOverlayMonth}
          setSelectedDay={setOverlayDay}
          selectedHour="00"
          selectedMinute="00"
          setSelectedHour={() => {}}
          setSelectedMinute={() => {}}
          value={overlayValue}
          id="mini-cal"
          timezone={tz}
          type="date"
          maxDate="9999-12-31"
          minDate="0001-01-01"
        />
        <div className={clsx(style.viewToggle, "me-4")}>
          <button
            className={`${style.viewToggleButton} ${viewMode === "day" ? style.viewToggleActive : ""}`}
            onClick={() => setViewMode("day")}
          >
            {t("calendar.day", "Day")}
          </button>
          <button
            className={`${style.viewToggleButton} ${viewMode === "week" ? style.viewToggleActive : ""}`}
            onClick={() => setViewMode("week")}
          >
            {t("calendar.week", "Week")}
          </button>
        </div>
      </TopActionBarPortal>

      {allDayPages.length > 0 && (
        <div className={style.allDaySection}>
          {allDayPages.map((page) => (
            <div
              key={page.id}
              className={style.allDayBadge}
              onClick={() => navigate(`/page/${page.id}`)}
              style={(() => {
                const c =
                  page.color ??
                  (page.path &&
                    [...page.path].reverse().find((p) => p.color)?.color) ??
                  null;
                return c
                  ? {
                      backgroundColor: `color-mix(in srgb, ${c}, transparent 85%)`,
                      color: c,
                    }
                  : undefined;
              })()}
            >
              {page.title || t("common.untitled", "Untitled")}
            </div>
          ))}
        </div>
      )}

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        autoScroll={false}
      >
        {viewMode === "day" ? (
          /* ── Day View ── */
          <>
            <div className={style.dayHeader}>
              <div className={style.weekTimeLabelSpacer} />
              <div
                className={clsx(
                  style.dayHeaderDay,
                  isToday && style.weekDayHeaderToday,
                )}
              >
                <span className={style.weekDayName}>
                  {shortDayName(selectedDate)}
                </span>
                <span className={style.weekDayNumber}>
                  {selectedDate.getDate()}
                </span>
              </div>
            </div>
            <div
              className={style.timeline}
              ref={timelineRef}
            >
              <div
                className={style.swipeStrip}
                /* Day view pans between days on a horizontal drag, so the
                   sidebar's open-drag must keep its hands off this one. The
                   week-view strip below has no such drag and is left alone. */
                data-drawer-swipe="off"
                onTouchStart={handleSwipeTouchStart} onTouchEnd={handleSwipeTouchEnd} onTouchCancel={handleSwipeTouchEnd}>
              <div className={style.swipeTrack} ref={swipeTrackRef}>
                {/* Previous day */}
                <div className={style.swipePanel}>
                  <div
                    className={style.timelineGrid}
                    style={{ height: TOTAL_HOURS * hourHeight }}
                  >
                    {renderHourLines()}
                    {getLaidOutPages(
                      getPagesForDay(prevDate).filter(
                        (p) => !activeDragPage || p.id !== activeDragPage.id,
                      ),
                      prevDate,
                    ).map(({ page, layout }) => (
                      <EventCard
                        key={page.id}
                        page={page}
                        layout={layout}
                        hourHeight={hourHeight}
                        onResizeStart={noopHandler}
                        onEventClick={noopHandler}
                        isDraft={false}
                      />
                    ))}
                    {isSameDay(prevDate, today) && (
                      <>
                        <div
                          className={style.nowIndicatorDot}
                          style={{ top: (nowMinutes / 60) * hourHeight }}
                        />
                        <div
                          className={style.nowIndicator}
                          style={{ top: (nowMinutes / 60) * hourHeight }}
                        />
                      </>
                    )}
                  </div>
                </div>

                {/* Current day */}
                <div className={style.swipePanel}>
                  <div
                    ref={gridRef}
                    className={style.timelineGrid}
                    style={{ height: TOTAL_HOURS * hourHeight }}
                    onMouseDown={handleGridMouseDown}
                    onTouchStart={handleGridTouchStart}
                    onTouchEnd={handleGridTouchEnd}
                    onTouchCancel={handleGridTouchEnd}
                  >
                    {renderHourLines()}

                    {getLaidOutPages(getPagesForDay(selectedDate), selectedDate).map(
                      ({ page, layout }) => (
                        <EventCard
                          key={page.id}
                          page={page}
                          layout={layout}
                          hourHeight={hourHeight}
                          onResizeStart={handleResizeStart}
                          onEventClick={handleEventClick}
                          onDuplicate={(id) =>
                            duplicatePage(id, { select: true })
                          }
                          onDelete={handleEventDelete}
                          isDraft={page.id === "__draft__"}
                        />
                      ),
                    )}

                    {/* Keep dragged EventCard mounted during edge-drag navigation */}
                    {/* {activeDragPage &&
                      !getPagesForDay(selectedDate).some(
                        (p) => p.id === activeDragPage.id,
                      ) && (
                        <EventCard
                          key={activeDragPage.id}
                          page={activeDragPage}
                          onResizeStart={noopHandler}
                          onEventClick={noopHandler}
                          isDraft={activeDragPage.id === "__draft__"}
                        />
                      )} */}

                    {/* Move-drag ghost preview on grid */}
                    {activeDragPage &&
                      (() => {
                        const oldStartMin = pageToStartMin(activeDragPage);
                        const duration = activeDragPage.duration || 60;
                        let newStartMin = oldStartMin + dragDeltaMinutes;
                        newStartMin = Math.max(
                          0,
                          Math.min(
                            newStartMin,
                            TOTAL_HOURS * 60 - SNAP_MINUTES,
                          ),
                        );
                        const top = (newStartMin / 60) * hourHeight;
                        const height = (duration / 60) * hourHeight;
                        const layout = getTransientLayout(
                          selectedDate,
                          {
                            id: "__drag_ghost__",
                            startMinutes: newStartMin,
                            duration,
                          },
                          activeDragPage.id,
                        );

                        return (
                          <div
                            className={style.dropGhost}
                            style={{
                              top,
                              height,
                              ...getEventLaneInsets(layout, false),
                            }}
                          >
                            <span
                              className={clsx(
                                style.dropGhostTime,
                                height < 18 && style.dropGhostTimeBelow,
                              )}
                            >
                              {formatTimeRange(
                                newStartMin,
                                newStartMin + duration,
                              )}
                            </span>
                          </div>
                        );
                      })()}

                    {/* Resize ghost time label */}
                    {resize &&
                      resizeDuration !== null &&
                      (() => {
                        const endMin = resize.originalStartMin + resizeDuration;
                        const top = (endMin / 60) * hourHeight;
                        return (
                          <div
                            className={style.resizeTimeLabel}
                            style={{ top }}
                          >
                            {formatTime(endMin)}
                          </div>
                        );
                      })()}

                    {/* Create-drag preview */}
                    {createDrag && (
                      <div
                        className={style.dragPreview}
                        style={{
                          top: (createDrag.startMinutes / 60) * hourHeight,
                          height:
                            ((createDrag.endMinutes - createDrag.startMinutes) /
                              60) *
                            hourHeight,
                          ...getEventLaneInsets(
                            getTransientLayout(selectedDate, {
                              id: "__create_ghost__",
                              startMinutes: createDrag.startMinutes,
                              duration:
                                createDrag.endMinutes - createDrag.startMinutes,
                            }),
                            false,
                          ),
                        }}
                      >
                        <span className={style.dragPreviewTime}>
                          {formatTimeRange(createDrag.startMinutes, createDrag.endMinutes)}
                        </span>
                      </div>
                    )}

                    {/* Now indicator */}
                    {isToday && (
                      <>
                        <div
                          className={style.nowIndicatorDot}
                          style={{ top: (nowMinutes / 60) * hourHeight }}
                        />
                        <div
                          className={style.nowIndicator}
                          style={{ top: (nowMinutes / 60) * hourHeight }}
                        />
                      </>
                    )}
                  </div>
                </div>

                {/* Next day */}
                <div className={style.swipePanel}>
                  <div
                    className={style.timelineGrid}
                    style={{ height: TOTAL_HOURS * hourHeight }}
                  >
                    {renderHourLines()}
                    {getLaidOutPages(
                      getPagesForDay(nextDate).filter(
                        (p) => !activeDragPage || p.id !== activeDragPage.id,
                      ),
                      nextDate,
                    ).map(({ page, layout }) => (
                      <EventCard
                        key={page.id}
                        page={page}
                        layout={layout}
                        hourHeight={hourHeight}
                        onResizeStart={noopHandler}
                        onEventClick={noopHandler}
                        isDraft={false}
                      />
                    ))}
                    {isSameDay(nextDate, today) && (
                      <>
                        <div
                          className={style.nowIndicatorDot}
                          style={{ top: (nowMinutes / 60) * hourHeight }}
                        />
                        <div
                          className={style.nowIndicator}
                          style={{ top: (nowMinutes / 60) * hourHeight }}
                        />
                      </>
                    )}
                  </div>
                </div>
              </div>
              </div>
            </div>
          </>
        ) : (
          /* ── Week View ── */
          <>
            <div
              className={style.timeline}
              ref={timelineRef}
            >
            <div className={style.weekHeader}>
              <div className={style.weekTimeLabelSpacer} />
              {weekDays.map((day, i) => (
                <div
                  key={i}
                  className={`${style.weekDayHeader} ${isSameDay(day, today) ? style.weekDayHeaderToday : ""}`}
                  onClick={() =>
                    guardDiscard(() => {
                      setSelectedDate(day);
                      setViewMode("day");
                    })
                  }
                >
                  <span className={style.weekDayName}>{shortDayName(day)}</span>
                  <span className={style.weekDayNumber}>{day.getDate()}</span>
                </div>
              ))}
            </div>
              <div className={style.swipeStrip} onTouchStart={handleSwipeTouchStart} onTouchEnd={handleSwipeTouchEnd} onTouchCancel={handleSwipeTouchEnd}>
              <div className={style.swipeTrack} ref={swipeTrackRef}>
                <div className={style.swipePanel}>
                  {renderWeekPanel(prevWeekDays, false)}
                </div>
                <div className={style.swipePanel}>
                  {renderWeekPanel(weekDays, true)}
                </div>
                <div className={style.swipePanel}>
                  {renderWeekPanel(nextWeekDays, false)}
                </div>
              </div>
              </div>
            </div>
          </>
        )}

      </DndContext>

      <EventPreview
        pageId={previewPageId}
        anchor={previewAnchor}
        onClose={handlePreviewClose}
        sidebarMode={sidebarMode ?? false}
        onSidebarModeChange={setSidebarMode}
        onDuplicate={(id) => duplicatePage(id, { select: true })}
        draft={draftEvent}
        onDraftDiscard={closePreviewNow}
        onDraftSave={handleDraftSave}
        onDraftScheduleChange={(scheduledAt, duration) =>
          setDraftEvent((d) => (d ? { ...d, scheduledAt, duration } : d))
        }
        onDraftContentChange={setDraftHasContent}
        calendarInteractionActive={
          activeDragPage !== null || resize !== null || createDrag !== null
        }
      />
    </div>
  );
}
