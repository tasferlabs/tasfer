import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { useSpaces } from "../../contexts/SpaceContext";
import useLocalStorage from "../../hooks/useLocalStorage";
import type { Block } from "@/deserializer/loadPage";
import { extractTitleFromBlocks } from "@/editor/sync/char-runs";
import {
  useGetCalendarPages,
  useCreatePage,
  useUpdatePage,
  updatePage as updatePageApi,
  type ICalendarPage,
  type HLC,
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
  isSameDay,
  getDayRange,
  getWeekRange,
  getWeekDays,
  pxToMinutes,
  snapPx,
  pageToStartMin,
  shortDayName,
  type ViewMode,
} from "./utils";
import { EventCard } from "./EventCard";
import { EventPreview } from "./EventPreview";
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
  const navigate = useNavigate();
  const { activeSpaceId } = useSpaces();
  const timelineRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [viewMode, setViewMode] = useLocalStorage<ViewMode>(
    "calendar-view",
    "day",
  );
  const [sidebarMode, setSidebarMode] = useLocalStorage<boolean>(
    "calendar-preview-sidebar",
    false,
  );

  const today = useMemo(() => new Date(), []);
  const isToday = isSameDay(selectedDate, today);

  // ── Event preview ──
  const previewJustClosedRef = useRef(false);
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
  const [previewAnchor, setPreviewAnchor] = useState<DOMRect | null>(null);
  const [draftEvent, setDraftEvent] = useState<DraftEvent | null>(null);
  const queryClient = useQueryClient();

  const handlePreviewClose = useCallback(() => {
    setPreviewPageId(null);
    setPreviewAnchor(null);
    setDraftEvent(null);
    previewJustClosedRef.current = true;
    requestAnimationFrame(() => {
      previewJustClosedRef.current = false;
    });
  }, []);

  const handleEventClick = useCallback(
    (pageId: string, rect: DOMRect) => {
      if (pageId === "__draft__") {
        // Draft event clicked - just set anchor for positioning
        setPreviewAnchor(rect);
        return;
      }
      setDraftEvent(null);
      setPreviewPageId(pageId);
      setPreviewAnchor(rect);
    },
    [],
  );

  // Compute query range based on view
  const { start, end } = useMemo(() => {
    if (viewMode === "week") return getWeekRange(selectedDate);
    return getDayRange(selectedDate);
  }, [selectedDate, viewMode]);

  const weekDays = useMemo(() => getWeekDays(selectedDate), [selectedDate]);

  const { data: pages } = useGetCalendarPages(activeSpaceId, start, end);

  const { mutate: createPage } = useCreatePage({
    onSuccess: async (newPage) => {
      // Save draft snapshot content to the new page
      const { snapshot, clock } = draftSnapshotRef.current;
      if (snapshot) {
        await updatePageApi({
          id: newPage.id,
          snapshot,
          snapshotClock: clock,
          title: extractTitleFromBlocks(snapshot),
        });
      }
      draftSnapshotRef.current = {};
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      setDraftEvent(null);
      setPreviewPageId(newPage.id);
      setPreviewAnchor(null);
    },
  });

  const { mutate: updatePage } = useUpdatePage({
    onSuccess: () => {
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
        scheduledAt: scheduledDate.toISOString(),
        duration: durationMinutes,
      });
      setPreviewPageId(null);
      setPreviewAnchor(null);
    },
    [activeSpaceId, selectedDate],
  );

  const draftSnapshotRef = useRef<{ snapshot?: Block[]; clock?: HLC | null }>({});

  const handleDraftSave = useCallback((snapshot?: Block[], clock?: HLC | null, parentId?: string | null) => {
    if (!draftEvent || !activeSpaceId) return;
    // Store snapshot to save after page creation
    draftSnapshotRef.current = { snapshot, clock };
    createPage({
      title: snapshot ? extractTitleFromBlocks(snapshot) : "",
      parentId: parentId ?? null,
      spaceId: activeSpaceId,
      scheduledAt: draftEvent.scheduledAt,
      duration: draftEvent.duration,
    });
  }, [draftEvent, activeSpaceId, createPage]);

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
        autoTitle: false,
        parentId: null,
        order: 0,
        scheduledAt: draftEvent.scheduledAt,
        duration: draftEvent.duration,
        allDay: false,
        recurrenceId: null,
        createdAt: new Date().toISOString(),
      });
    }
    return { timedPages, allDayPages };
  }, [pages, draftEvent]);

  // Group timed pages by day (for week view)
  const pagesByDay = useMemo(() => {
    const map = new Map<string, ICalendarPage[]>();
    for (const page of timedPages) {
      const d = new Date(page.scheduledAt);
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
      const currentHour = new Date().getHours();
      const targetScroll =
        currentHour * HOUR_HEIGHT - timelineRef.current.clientHeight / 3;
      timelineRef.current.scrollTop = Math.max(0, targetScroll);
    }
  }, [selectedDate, viewMode]);

  // ── Day navigation ──
  function goToDay(offset: number) {
    setSelectedDate((prev) => {
      const next = new Date(prev);
      if (viewMode === "week") {
        next.setDate(next.getDate() + offset * 7);
      } else {
        next.setDate(next.getDate() + offset);
      }
      return next;
    });
  }

  function goToToday() {
    setSelectedDate(new Date());
  }

  // ── dnd-kit: drag to move events ──
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const [activeDragPage, setActiveDragPage] = useState<ICalendarPage | null>(
    null,
  );
  const [dragDeltaMinutes, setDragDeltaMinutes] = useState(0);
  const [dragTargetDay, setDragTargetDay] = useState<Date | null>(null);

  // Track which column the pointer is over during drag (for week view cross-day drag)
  useEffect(() => {
    if (!activeDragPage || viewMode !== "week") return;

    function handlePointerMove(e: PointerEvent) {
      if (!gridRef.current) return;
      const columns =
        gridRef.current.querySelectorAll<HTMLElement>("[data-day-index]");
      for (const col of columns) {
        const rect = col.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX < rect.right) {
          const idx = parseInt(col.dataset.dayIndex!, 10);
          setDragTargetDay(weekDays[idx]);
          return;
        }
      }
    }

    window.addEventListener("pointermove", handlePointerMove);
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [activeDragPage, viewMode, weekDays]);

  function handleDragStart(event: DragStartEvent) {
    const page = event.active.data.current?.page as ICalendarPage | undefined;
    if (page) {
      setActiveDragPage(page);
      setDragDeltaMinutes(0);
      setDragTargetDay(null);
    }
  }

  function handleDragMove(event: { delta: { y: number } }) {
    const snappedDeltaPx = snapPx(event.delta.y);
    setDragDeltaMinutes(pxToMinutes(snappedDeltaPx));
  }

  function handleDragEnd(_event: DragEndEvent) {
    if (activeDragPage) {
      const oldStartMin = pageToStartMin(activeDragPage);
      let newStartMin = oldStartMin + dragDeltaMinutes;
      newStartMin = Math.max(
        0,
        Math.min(newStartMin, TOTAL_HOURS * 60 - SNAP_MINUTES),
      );

      const targetDate = dragTargetDay || new Date(activeDragPage.scheduledAt);
      const scheduledDate = new Date(targetDate);
      scheduledDate.setHours(0, 0, 0, 0);
      scheduledDate.setMinutes(newStartMin);

      const newISO = scheduledDate.toISOString();
      if (newISO !== activeDragPage.scheduledAt) {
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
  }

  function handleDragCancel() {
    setActiveDragPage(null);
    setDragDeltaMinutes(0);
    setDragTargetDay(null);
  }

  // ── Resize (bottom handle drag) ──
  const [resize, setResize] = useState<ResizeState | null>(null);
  const [resizeDuration, setResizeDuration] = useState<number | null>(null);

  function handleResizeStart(pageId: string, e: React.PointerEvent) {
    const page = timedPages.find((p) => p.id === pageId);
    if (!page) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setResize({
      pageId,
      originalDuration: page.duration || 60,
      originalStartMin: pageToStartMin(page),
      startY: e.clientY,
    });
    setResizeDuration(page.duration || 60);
  }

  useEffect(() => {
    if (!resize) return;

    function handlePointerMove(e: PointerEvent) {
      if (!resize) return;
      const deltaPx = snapPx(e.clientY - resize.startY);
      const deltaMin = pxToMinutes(deltaPx);
      const newDuration = Math.max(
        MIN_DRAG_MINUTES,
        resize.originalDuration + deltaMin,
      );
      const maxDuration = TOTAL_HOURS * 60 - resize.originalStartMin;
      setResizeDuration(Math.min(newDuration, maxDuration));
    }

    function handlePointerUp() {
      if (
        resize &&
        resizeDuration !== null &&
        resizeDuration !== resize.originalDuration
      ) {
        if (resize.pageId === "__draft__") {
          setDraftEvent((prev) =>
            prev ? { ...prev, duration: resizeDuration! } : prev,
          );
        } else {
          updatePage({
            id: resize.pageId,
            duration: resizeDuration,
          });
        }
      }
      setResize(null);
      setResizeDuration(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [resize, resizeDuration, updatePage]);

  // ── Click-and-drag to create ──
  const [createDrag, setCreateDrag] = useState<CreateDragState | null>(null);
  const isCreateDragging = useRef(false);

  function getColumnDateFromEvent(e: React.MouseEvent): Date {
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

  function handleGridMouseDown(e: React.MouseEvent) {
    if ((!sidebarMode && (previewPageId || draftEvent)) || previewJustClosedRef.current) return;
    if ((e.target as HTMLElement).closest(`.${style.eventCard}`)) return;
    if ((e.target as HTMLElement).closest(`.${style.resizeHandle}`)) return;
    e.preventDefault();

    const date = getColumnDateFromEvent(e);
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

  // ── Now indicator ──
  const [nowMinutes, setNowMinutes] = useState(() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  });

  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
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
  }, [createPageAtTime, viewMode, previewPageId]);

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
              dragTargetDay || new Date(activeDragPage.scheduledAt);
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

            return (
              <div
                className={style.dropGhost}
                style={{ top, height: Math.max(height, 20), left: 0, right: 0 }}
              >
                <span className={style.dropGhostTime}>
                  {formatTime(newStartMin)} -{" "}
                  {formatTime(newStartMin + duration)}
                </span>
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
              left: 0,
              right: 0,
            }}
          >
            <span className={style.dragPreviewTime}>
              {formatTime(createDrag.startMinutes)} -{" "}
              {formatTime(createDrag.endMinutes)}
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
                  left: -4,
                  width: 8,
                  height: 8,
                }}
              />
            )}
            <div
              className={style.nowIndicator}
              style={{ top: (nowMinutes / 60) * HOUR_HEIGHT, left: 0 }}
            />
          </>
        )}
      </div>
    );
  }

  const headerSlot = document.getElementById("top-action-bar-slot");

  return (
    <div className={style.container}>
      {headerSlot &&
        createPortal(
          <>
            <div className={style.headerNav}>
              <button className={style.headerNavButton} onClick={() => goToDay(-1)}>
                &#8249;
              </button>
              <button className={style.todayButton} onClick={goToToday}>
                {t("Today")}
              </button>
              <button className={style.headerNavButton} onClick={() => goToDay(1)}>
                &#8250;
              </button>
            </div>
            <span className={style.headerTitle}>
              {viewMode === "day"
                ? formatDate(selectedDate)
                : formatWeekRange(selectedDate)}
            </span>
            <div className={clsx(style.viewToggle, "me-4")}>
              <button
                className={`${style.viewToggleButton} ${viewMode === "day" ? style.viewToggleActive : ""}`}
                onClick={() => setViewMode("day")}
              >
                {t("Day")}
              </button>
              <button
                className={`${style.viewToggleButton} ${viewMode === "week" ? style.viewToggleActive : ""}`}
                onClick={() => setViewMode("week")}
              >
                {t("Week")}
              </button>
            </div>
          </>,
          headerSlot,
        )}

      {allDayPages.length > 0 && (
        <div className={style.allDaySection}>
          {allDayPages.map((page) => (
            <div
              key={page.id}
              className={style.allDayBadge}
              onClick={() => navigate(`/page/${page.id}`)}
            >
              {page.title || t("Untitled")}
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
      >
        {viewMode === "day" ? (
          /* ── Day View ── */
          <div className={style.timeline} ref={timelineRef}>
            <div
              ref={gridRef}
              className={style.timelineGrid}
              style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}
              onMouseDown={handleGridMouseDown}
            >
              {renderHourLines()}

              {timedPages.map((page) => (
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
                  isDraft={page.id === "__draft__"}
                />
              ))}

              {/* Move-drag ghost preview on grid */}
              {activeDragPage &&
                (() => {
                  const oldStartMin = pageToStartMin(activeDragPage);
                  const duration = activeDragPage.duration || 60;
                  let newStartMin = oldStartMin + dragDeltaMinutes;
                  newStartMin = Math.max(
                    0,
                    Math.min(newStartMin, TOTAL_HOURS * 60 - SNAP_MINUTES),
                  );
                  const top = (newStartMin / 60) * HOUR_HEIGHT;
                  const height = (duration / 60) * HOUR_HEIGHT;

                  return (
                    <div
                      className={style.dropGhost}
                      style={{ top, height: Math.max(height, 20) }}
                    >
                      <span className={style.dropGhostTime}>
                        {formatTime(newStartMin)} -{" "}
                        {formatTime(newStartMin + duration)}
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
                    <div className={style.resizeTimeLabel} style={{ top }}>
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
                      ((createDrag.endMinutes - createDrag.startMinutes) / 60) *
                      HOUR_HEIGHT,
                  }}
                >
                  <span className={style.dragPreviewTime}>
                    {formatTime(createDrag.startMinutes)} -{" "}
                    {formatTime(createDrag.endMinutes)}
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
        ) : (
          /* ── Week View ── */
          <div className={style.timeline} ref={timelineRef}>
            {/* Week header row */}
            <div className={style.weekHeader}>
              <div className={style.weekTimeLabelSpacer} />
              {weekDays.map((day, i) => (
                <div
                  key={i}
                  className={`${style.weekDayHeader} ${isSameDay(day, today) ? style.weekDayHeaderToday : ""}`}
                  onClick={() => {
                    setSelectedDate(day);
                    setViewMode("day");
                  }}
                >
                  <span className={style.weekDayName}>{shortDayName(day)}</span>
                  <span className={style.weekDayNumber}>{day.getDate()}</span>
                </div>
              ))}
            </div>
            {/* Week grid */}
            <div
              ref={gridRef}
              className={style.weekGrid}
              style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}
              onMouseDown={handleGridMouseDown}
            >
              {/* Time labels column */}
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
              {/* Day columns */}
              {weekDays.map((day, i) => (
                <div
                  key={i}
                  className={style.weekColumnWrapper}
                  data-day-index={i}
                >
                  {Array.from({ length: TOTAL_HOURS }, (_, hour) => (
                    <div
                      key={hour}
                      className={style.weekHourLine}
                      style={{ top: hour * HOUR_HEIGHT }}
                    />
                  ))}
                  {renderDayColumn(day, getPagesForDay(day), i)}
                </div>
              ))}
            </div>
          </div>
        )}

        <DragOverlay dropAnimation={null} />
      </DndContext>

      <EventPreview
        pageId={previewPageId}
        anchor={previewAnchor}
        onClose={handlePreviewClose}
        sidebarMode={sidebarMode ?? false}
        onSidebarModeChange={setSidebarMode}
        draft={draftEvent}
        onDraftSave={handleDraftSave}
      />
    </div>
  );
}
