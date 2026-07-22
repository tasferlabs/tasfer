import { useMemo, useRef, useEffect, useLayoutEffect, useState, useCallback } from "react";
import { TopActionBarPortal } from "../../layout/TopActionBarSlot";
import { useNavigate, useBlocker } from "react-router-dom";
import { useConfirmation } from "@/app/components/ConfirmationDialog";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
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
import useResponsive from "../../hooks/useResponsive";
import type { Block } from "@tasfer/editor";
import { deriveTitles } from "@/lib/pageTitle";
import { getResolvedTimezone } from "@/lib/dateTimePreferences";
import { getPlatform } from "@/platform";
import {
  useGetCalendarPages,
  useCreatePage,
  useUpdatePage,
  updatePage as updatePageApi,
  type ICalendarPage,
} from "../../api/pages.api";
import {
  HOUR_HEIGHT,
  TOTAL_HOURS,
  SNAP_MINUTES,
  MIN_DRAG_MINUTES,
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
  pageToStartMin,
  shortDayName,
  formatMonthLong,
  zonedWallDate,
  wallDateToUtcIso,
  wallMsToInstantMs,
  wallNow,
  type ViewMode,
} from "./utils";
import { triggerHaptic } from "@/platform/bridge";
import { useP2PPageEventsWithQueryClient } from "../../hooks/useP2PPageEvents";
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

// ── Resize state ──

interface ResizeState {
  pageId: string;
  originalDuration: number;
  originalStartMin: number;
  startY: number;
}

// ── Main component ──

export default function CalendarPage() {
  const { t } = useTranslation();
  const isRtl = i18next.dir() === "rtl";
  const navigate = useNavigate();
  const { getConfirmation } = useConfirmation();
  const isMobile = useResponsive("(max-width: 768px)");
  const { activeSpaceId } = useSpaces();
  useP2PPageEventsWithQueryClient();
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

  const today = useMemo(() => wallNow(), []);
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

  const handlePreviewClose = useCallback(() => {
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
        title: t("calendar.discardDraftTitle", "Discard this event?"),
        description: t(
          "calendar.discardDraftBody",
          "You've started creating this event. Discard it?",
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
      title: t("calendar.discardDraftTitle", "Discard this event?"),
      description: t(
        "calendar.discardDraftBody",
        "You've started creating this event. Discard it?",
      ),
      cancelText: t("calendar.keepEditing", "Keep editing"),
      confirmText: t("common.discard", "Discard"),
    }).then((confirmed) => {
      if (confirmed) routeBlocker.proceed();
      else routeBlocker.reset();
    });
  }, [routeBlocker, getConfirmation, t]);

  const handleEventClick = useCallback((pageId: string, rect: DOMRect) => {
    if (pageId === "__draft__") {
      // Draft event clicked - just set anchor for positioning
      setPreviewAnchor(rect);
      return;
    }
    setDraftEvent(null);
    setPreviewPageId(pageId);
    setPreviewAnchor(rect);
  }, []);

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

  const createPageAtTime = useCallback(
    (startMinutes: number, durationMinutes: number, date?: Date) => {
      if (!activeSpaceId) return;
      const scheduledDate = new Date(date || selectedDate);
      scheduledDate.setHours(0, 0, 0, 0);
      scheduledDate.setMinutes(startMinutes);
      setDraftEvent({
        scheduledAt: wallDateToUtcIso(scheduledDate),
        duration: durationMinutes,
      });
      setPreviewPageId(null);
      setPreviewAnchor(null);
    },
    [activeSpaceId, selectedDate],
  );

  // Duplicate an existing event into a new page: copies its title, parent,
  // color, duration, task flag, and body content. `scheduledAt` overrides the
  // copy's time (used by Ctrl/Cmd-drag to drop the copy at a new slot); when
  // omitted the copy lands at the original's time. `select` opens the new
  // event's preview afterwards (used by the Duplicate button).
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
      // writeBlocks reuses the new page's init block for the first block, so we
      // don't end up with a duplicated leading heading.
      if (src.blocks && src.blocks.length > 0) {
        await getPlatform().ops.writeBlocks(newPage.id, src.blocks);
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

  // Scroll to current hour on mount
  useEffect(() => {
    if (timelineRef.current) {
      const currentHour = wallNow().getHours();
      const targetScroll =
        currentHour * HOUR_HEIGHT - timelineRef.current.clientHeight / 3;
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
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 8 },
    }),
  );

  const [activeDragPage, setActiveDragPage] = useState<ICalendarPage | null>(
    null,
  );
  const [dragDeltaMinutes, setDragDeltaMinutes] = useState(0);
  const [dragTargetDay, setDragTargetDay] = useState<Date | null>(null);

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
              const onEnd = () => {
                track.removeEventListener("transitionend", onEnd);
                setSelectedDate((prev) => {
                  const next = new Date(prev);
                  next.setDate(next.getDate() + (viewMode === "week" ? edgeDir! * 7 : edgeDir!));
                  return next;
                });
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

  function handleDragStart(event: DragStartEvent) {
    const page = event.active.data.current?.page as ICalendarPage | undefined;
    if (page) {
      triggerHaptic("medium");
      setActiveDragPage(page);
      setDragDeltaMinutes(0);
      setDragTargetDay(null);
      const ae = event.activatorEvent as
        | { ctrlKey?: boolean; metaKey?: boolean }
        | undefined;
      setDragDuplicate(!!ae && (!!ae.ctrlKey || !!ae.metaKey));
    }
  }

  function handleDragMove(event: { delta: { y: number } }) {
    const snappedDeltaPx = snapPx(event.delta.y);
    setDragDeltaMinutes(pxToMinutes(snappedDeltaPx));
  }

  function handleDragEnd(_event: DragEndEvent) {
    clearEdgeDragTimer();
    edgeDragTargetDayRef.current = null;
    if (activeDragPage) {
      const oldStartMin = pageToStartMin(activeDragPage);
      let newStartMin = oldStartMin + dragDeltaMinutes;
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
    setDragTargetDay(null);
    setDragDuplicate(false);
  }

  function handleDragCancel() {
    clearEdgeDragTimer();
    edgeDragTargetDayRef.current = null;
    setActiveDragPage(null);
    setDragDeltaMinutes(0);
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
    };
    const dur = page.duration || 60;

    resizeRef.current = state;
    resizeDurationRef.current = dur;
    setResize(state);
    setResizeDuration(dur);

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
      const deltaPx = snapPx(ev.clientY - r.startY);
      const deltaMin = pxToMinutes(deltaPx);
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
      resizeRef.current = null;
      resizeDurationRef.current = null;
      setResize(null);
      setResizeDuration(null);
      cleanup();
    }

    function cleanup() {
      if (timeline) {
        timeline.removeEventListener("touchmove", preventScroll);
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      resizeCleanupRef.current = null;
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
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
      Math.min(pxToMinutes(y), TOTAL_HOURS * 60 - SNAP_MINUTES),
    );

    isCreateDragging.current = true;
    setCreateDrag({
      startMinutes: minutes,
      endMinutes: minutes + SNAP_MINUTES,
      date,
    });
  }

  useEffect(() => {
    if (!isCreateDragging.current) return;

    function handleMouseMove(e: MouseEvent) {
      if (!isCreateDragging.current) return;
      const el = gridRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.max(
        0,
        Math.min(pxToMinutes(y), TOTAL_HOURS * 60 - SNAP_MINUTES),
      );

      setCreateDrag((prev) => {
        if (!prev) return prev;
        const endMin = Math.max(
          prev.startMinutes + MIN_DRAG_MINUTES,
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
  } | null>(null);

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
      Math.min(pxToMinutes(y), TOTAL_HOURS * 60 - SNAP_MINUTES),
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
      const target = e.target as HTMLElement;
      if (target.closest(`.${style.eventCard}`)) return;
      if (target.closest(`.${style.resizeHandle}`)) return;

      const touch = e.touches[0];
      const scrollTop = timelineRef.current?.scrollTop ?? 0;

      const timer = setTimeout(() => {
        const state = touchCreateRef.current;
        if (!state) return;

        // Activate create mode
        state.active = true;

        // Haptic feedback (native bridge on iOS/Android, Vibration API fallback)
        triggerHaptic("medium");

        const date = getColumnDateFromElement(state.targetEl);
        const minutes = getMinutesFromClientY(state.startY);

        setCreateDrag({
          startMinutes: minutes,
          endMinutes: minutes + SNAP_MINUTES,
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

  // Native touchmove handler for create-drag (needs passive: false to preventDefault)
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;

    function onTouchMoveCreate(e: TouchEvent) {
      const state = touchCreateRef.current;
      if (!state) return;

      const touch = e.touches[0];

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

      const startMinutes = getMinutesFromClientY(state.startY);
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
            Math.max(maxMin, minMin + MIN_DRAG_MINUTES),
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
    },
    [createPageAtTime],
  );

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

  // ── Now indicator ──
  const [nowMinutes, setNowMinutes] = useState(() => {
    const now = wallNow();
    return now.getHours() * 60 + now.getMinutes();
  });

  useEffect(() => {
    const interval = setInterval(() => {
      const now = wallNow();
      setNowMinutes(now.getHours() * 60 + now.getMinutes());
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
  }, [createPageAtTime, viewMode, previewPageId, draftEvent]);

  const noopHandler = useCallback(() => {}, []);

  // ── Render helpers ──

  function renderHourLines() {
    return Array.from({ length: TOTAL_HOURS }, (_, hour) => (
      <div
        key={hour}
        className={style.hourLine}
        style={{ top: hour * HOUR_HEIGHT }}
      >
        {viewMode === "day" && (
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
        style={{ position: "relative", height: TOTAL_HOURS * HOUR_HEIGHT }}
      >
        {dayPages.map((page) => (
          <EventCard
            key={page.id}
            page={{
              ...page,
              duration:
                resize?.pageId === page.id && resizeDuration !== null
                  ? resizeDuration
                  : page.duration,
            }}
            onResizeStart={handleResizeStart}
            onEventClick={handleEventClick}
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
            const top = (newStartMin / 60) * HOUR_HEIGHT;
            const height = (duration / 60) * HOUR_HEIGHT;

            const duplicating =
              isDuplicateDrag && activeDragPage.id !== "__draft__";

            return (
              <div
                className={style.dropGhost}
                style={{ top, height: Math.max(height, 20), insetInlineStart: 0, insetInlineEnd: 0 }}
              >
                <span className={style.dropGhostTime}>
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
              top: (createDrag.startMinutes / 60) * HOUR_HEIGHT,
              height:
                ((createDrag.endMinutes - createDrag.startMinutes) / 60) *
                HOUR_HEIGHT,
              insetInlineStart: 0,
              insetInlineEnd: 0,
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
                  top: (nowMinutes / 60) * HOUR_HEIGHT,
                  insetInlineStart: -4,
                  width: 8,
                  height: 8,
                }}
              />
            )}
            <div
              className={style.nowIndicator}
              style={{ top: (nowMinutes / 60) * HOUR_HEIGHT, insetInlineStart: 0 }}
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
        style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}
        onMouseDown={isCenter ? handleGridMouseDown : undefined}
        onTouchStart={isCenter ? handleGridTouchStart : undefined}
        onTouchEnd={isCenter ? handleGridTouchEnd : undefined}
        onTouchCancel={isCenter ? handleGridTouchEnd : undefined}
      >
        <div className={style.weekTimeLabels}>
          {Array.from({ length: TOTAL_HOURS }, (_, hour) => (
            <div
              key={hour}
              className={style.weekTimeLabel}
              style={{ top: hour * HOUR_HEIGHT }}
            >
              {formatHour(hour)}
            </div>
          ))}
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
                  style={{ top: hour * HOUR_HEIGHT }}
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
        <span className={clsx(style.headerTitle, style.headerTitleDesktop)}>
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
        autoScroll={{
          threshold: { x: 0, y: 0.2 },
        }}
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
              <div className={style.swipeStrip} onTouchStart={handleSwipeTouchStart} onTouchEnd={handleSwipeTouchEnd} onTouchCancel={handleSwipeTouchEnd}>
              <div className={style.swipeTrack} ref={swipeTrackRef}>
                {/* Previous day */}
                <div className={style.swipePanel}>
                  <div
                    className={style.timelineGrid}
                    style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}
                  >
                    {renderHourLines()}
                    {getPagesForDay(prevDate)
                      .filter(
                        (p) => !activeDragPage || p.id !== activeDragPage.id,
                      )
                      .map((page) => (
                        <EventCard
                          key={page.id}
                          page={page}
                          onResizeStart={noopHandler}
                          onEventClick={noopHandler}
                          isDraft={false}
                        />
                      ))}
                    {isSameDay(prevDate, today) && (
                      <>
                        <div
                          className={style.nowIndicatorDot}
                          style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                        />
                        <div
                          className={style.nowIndicator}
                          style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
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
                    style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}
                    onMouseDown={handleGridMouseDown}
                    onTouchStart={handleGridTouchStart}
                    onTouchEnd={handleGridTouchEnd}
                    onTouchCancel={handleGridTouchEnd}
                  >
                    {renderHourLines()}

                    {getPagesForDay(selectedDate).map((page) => (
                      <EventCard
                        key={page.id}
                        page={{
                          ...page,
                          duration:
                            resize?.pageId === page.id &&
                            resizeDuration !== null
                              ? resizeDuration
                              : page.duration,
                        }}
                        onResizeStart={handleResizeStart}
                        onEventClick={handleEventClick}
                        isDraft={page.id === "__draft__"}
                      />
                    ))}

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
                        const top = (newStartMin / 60) * HOUR_HEIGHT;
                        const height = (duration / 60) * HOUR_HEIGHT;

                        return (
                          <div
                            className={style.dropGhost}
                            style={{ top, height: Math.max(height, 20) }}
                          >
                            <span className={style.dropGhostTime}>
                              {formatTimeRange(newStartMin, newStartMin + duration)}
                            </span>
                          </div>
                        );
                      })()}

                    {/* Resize ghost time label */}
                    {resize &&
                      resizeDuration !== null &&
                      (() => {
                        const endMin = resize.originalStartMin + resizeDuration;
                        const top = (endMin / 60) * HOUR_HEIGHT;
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
                          top: (createDrag.startMinutes / 60) * HOUR_HEIGHT,
                          height:
                            ((createDrag.endMinutes - createDrag.startMinutes) /
                              60) *
                            HOUR_HEIGHT,
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
                          style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                        />
                        <div
                          className={style.nowIndicator}
                          style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                        />
                      </>
                    )}
                  </div>
                </div>

                {/* Next day */}
                <div className={style.swipePanel}>
                  <div
                    className={style.timelineGrid}
                    style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}
                  >
                    {renderHourLines()}
                    {getPagesForDay(nextDate)
                      .filter(
                        (p) => !activeDragPage || p.id !== activeDragPage.id,
                      )
                      .map((page) => (
                        <EventCard
                          key={page.id}
                          page={page}
                          onResizeStart={noopHandler}
                          onEventClick={noopHandler}
                          isDraft={false}
                        />
                      ))}
                    {isSameDay(nextDate, today) && (
                      <>
                        <div
                          className={style.nowIndicatorDot}
                          style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                        />
                        <div
                          className={style.nowIndicator}
                          style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
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

        <DragOverlay dropAnimation={null} />
      </DndContext>

      <EventPreview
        pageId={previewPageId}
        anchor={previewAnchor}
        onClose={handlePreviewClose}
        sidebarMode={sidebarMode ?? false}
        onSidebarModeChange={setSidebarMode}
        onDuplicate={(id) => duplicatePage(id, { select: true })}
        draft={draftEvent}
        onDraftSave={handleDraftSave}
        onDraftScheduleChange={(scheduledAt, duration) =>
          setDraftEvent((d) => (d ? { ...d, scheduledAt, duration } : d))
        }
        onDraftContentChange={setDraftHasContent}
      />
    </div>
  );
}
