import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { DateTime } from "luxon";
import { formatDurationLabel, DURATION_OPTIONS } from "@/lib/utils";
import DateTimePicker from "@/components/datetimepickers/DateTimePicker";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxList,
  ComboboxItem,
} from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { useSpaces } from "../../contexts/SpaceContext";
import useLocalStorage from "../../hooks/useLocalStorage";
import useResponsive from "../../hooks/useResponsive";
import {
  useGetCalendarPages,
  useCreatePage,
  useUpdatePage,
  useGetPage,
  updatePage as updatePageApi,
  type ICalendarPage,
  type HLC,
} from "../../api/pages.api";
import type { Block } from "@/deserializer/loadPage";
import { useDebouncedSave } from "../../hooks/useDebouncedSave";
import { MountedEditor } from "../../MountedEditor";
import { Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import style from "./CalendarPage.module.css";


// ── Constants ──

const HOUR_HEIGHT = 60;
const TOTAL_HOURS = 24;
const SNAP_MINUTES = 15;
const MIN_DRAG_MINUTES = 15;
const SNAP_PX = (SNAP_MINUTES / 60) * HOUR_HEIGHT;

type ViewMode = "day" | "week";

// ── Helpers ──

function formatHour(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatWeekRange(date: Date): string {
  const { start, end } = getWeekRange(date);
  const startDate = new Date(start);
  const endDate = new Date(end);
  const sameMonth = startDate.getMonth() === endDate.getMonth();
  if (sameMonth) {
    return `${startDate.toLocaleDateString(undefined, { month: "long", day: "numeric" })} - ${endDate.getDate()}, ${endDate.getFullYear()}`;
  }
  return `${startDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${endDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function getDayRange(date: Date): { start: number; end: number } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start: start.getTime(), end: end.getTime() };
}

function getWeekRange(date: Date): { start: number; end: number } {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7)); // go to Monday
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: monday.getTime(), end: sunday.getTime() };
}

function getWeekDays(date: Date): Date[] {
  const { start } = getWeekRange(date);
  const monday = new Date(start);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0
    ? `${hour12} ${period}`
    : `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function formatEventTime(timestamp: number, duration?: number | null): string {
  const date = new Date(timestamp);
  const startMin = date.getHours() * 60 + date.getMinutes();
  if (duration) {
    return `${formatTime(startMin)} - ${formatTime(startMin + duration)}`;
  }
  return formatTime(startMin);
}

function pxToMinutes(px: number): number {
  const raw = (px / HOUR_HEIGHT) * 60;
  return Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
}

function snapPx(px: number): number {
  return Math.round(px / SNAP_PX) * SNAP_PX;
}

function pageToStartMin(page: ICalendarPage): number {
  const d = new Date(page.scheduledAt);
  return d.getHours() * 60 + d.getMinutes();
}

function shortDayName(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "short" });
}

// ── Draggable event card ──

function EventCard({
  page,
  onResizeStart,
  onEventClick,
  compact,
}: {
  page: ICalendarPage;
  onResizeStart: (pageId: string, e: React.PointerEvent) => void;
  onEventClick: (pageId: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const startMin = pageToStartMin(page);
  const duration = page.duration || 60;
  const top = (startMin / 60) * HOUR_HEIGHT;
  const height = (duration / 60) * HOUR_HEIGHT;

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `event-${page.id}`,
    data: { page },
  });

  // Determine how much content fits based on height
  const actualHeight = Math.max(height, 20);
  const timeStr = formatEventTime(page.scheduledAt, page.duration);
  // < 30px: single line with title only
  // 30-50px: title + short time on same line or below
  // > 50px: title + full time on separate line
  const showTimeSeparate = actualHeight > 40;
  const showTimeInline = !showTimeSeparate && actualHeight > 25;

  // Track if pointer moved (to distinguish click from drag)
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={setNodeRef}
      className={style.eventCard}
      style={{
        top,
        height: actualHeight,
        opacity: isDragging ? 0.3 : 1,
        ...(compact ? { left: 0, right: 0, padding: "2px 6px" } : {}),
      }}
      {...listeners}
      {...attributes}
      onPointerDown={(e) => {
        pointerStartRef.current = { x: e.clientX, y: e.clientY };
        // Call dnd-kit's listener
        listeners?.onPointerDown?.(e as any);
      }}
      onClick={(e) => {
        if (!pointerStartRef.current) return;
        const dx = e.clientX - pointerStartRef.current.x;
        const dy = e.clientY - pointerStartRef.current.y;
        // Only open if it was a click, not a drag
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
          onEventClick(page.id);
        }
        pointerStartRef.current = null;
      }}
    >
      {showTimeInline && compact ? (
        <div className={style.eventInline}>
          <span className={style.eventTitle} style={{ fontSize: "0.7rem" }}>
            {page.title || t("Untitled")}
          </span>
          <span className={style.eventTimeInline}>{formatTime(startMin)}</span>
        </div>
      ) : (
        <>
          <span
            className={style.eventTitle}
            style={compact ? { fontSize: "0.7rem" } : undefined}
          >
            {page.title || t("Untitled")}
          </span>
          {showTimeSeparate && (
            <div
              className={style.eventTime}
              style={compact ? { fontSize: "0.6rem" } : undefined}
            >
              {timeStr}
            </div>
          )}
        </>
      )}
      {/* Resize handle at bottom */}
      <div
        className={style.resizeHandle}
        onPointerDown={(e) => {
          e.stopPropagation();
          onResizeStart(page.id, e);
        }}
      />
    </div>
  );
}

// ── Drag overlay (follows cursor) ──

function EventOverlay({
  page,
  deltaMinutes,
}: {
  page: ICalendarPage;
  deltaMinutes: number;
}) {
  const { t } = useTranslation();
  const startMin = pageToStartMin(page) + deltaMinutes;
  const duration = page.duration || 60;
  return (
    <div className={style.eventOverlay}>
      <div className={style.eventTitle}>{page.title || t("Untitled")}</div>
      <div className={style.eventTime}>
        {formatTime(startMin)} - {formatTime(startMin + duration)}
      </div>
    </div>
  );
}

// ── Preview schedule controls ──

function PreviewScheduleControls({
  scheduledAt,
  duration,
  onChange,
}: {
  scheduledAt: number | null;
  duration: number | null;
  onChange: (scheduledAt: number, duration: number | null) => void;
}) {
  const { t } = useTranslation();
  const tz = DateTime.local().zoneName;
  const dateValue = scheduledAt
    ? DateTime.fromMillis(scheduledAt, { zone: tz }).toISO()
    : null;
  const currentDuration = duration ?? 60;

  const durationLabels = useMemo(
    () => DURATION_OPTIONS.map((d) => formatDurationLabel(d, t)),
    [t],
  );

  const handleDateChange = (value: string | null) => {
    if (!value) return;
    const ms = DateTime.fromISO(value, { zone: tz }).toMillis();
    if (!isNaN(ms)) onChange(ms, duration);
  };

  const handleDurationChange = (val: string) => {
    const idx = durationLabels.indexOf(val);
    if (idx !== -1 && scheduledAt) onChange(scheduledAt, DURATION_OPTIONS[idx]);
  };

  return (
    <div className={style.previewSchedule}>
      <DateTimePicker
        type="datetime"
        value={dateValue}
        onChange={handleDateChange}
        timezone={tz}
        size="small"
      />
      <Combobox
        items={durationLabels}
        defaultValue={formatDurationLabel(currentDuration, t)}
        onValueChange={(val) => {
          if (val != null) handleDurationChange(val);
        }}
      >
        <ComboboxInput placeholder={formatDurationLabel(currentDuration, t)} />
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
}

// ── Create-drag state ──

interface CreateDragState {
  startMinutes: number;
  endMinutes: number;
  date: Date; // which day column (for week view)
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

  const today = useMemo(() => new Date(), []);
  const isToday = isSameDay(selectedDate, today);
  const isMobile = useResponsive("(max-width: 768px)");

  // ── Event preview dialog ──
  const previewJustClosedRef = useRef(false);
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const { data: previewPage, isLoading: isPreviewLoading } = useGetPage(
    previewPageId || undefined,
  );
  const queryClient = useQueryClient();

  // Delay mounting editor until dialog/drawer animation completes
  useEffect(() => {
    if (previewPageId) {
      setEditorReady(false);
      const timer = setTimeout(() => setEditorReady(true), 200);
      return () => clearTimeout(timer);
    }
    setEditorReady(false);
  }, [previewPageId]);

  // Save edits from preview editor
  const handlePreviewSave = useCallback(
    async (data: { pageId: string; snapshot: Block[]; clock: HLC | null }) => {
      await updatePageApi({
        id: data.pageId,
        snapshot: data.snapshot,
        snapshotClock: data.clock,
      });
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
    [queryClient],
  );

  const { save: debouncedPreviewSave, flush: flushPreviewSave } =
    useDebouncedSave(handlePreviewSave, 1000);

  const handlePreviewContentChange = useCallback(
    (snapshot: Block[], clock: HLC | null) => {
      if (!previewPageId) return;
      debouncedPreviewSave({ pageId: previewPageId, snapshot, clock });
    },
    [previewPageId, debouncedPreviewSave],
  );

  // Flush pending save when dialog closes
  const handlePreviewClose = useCallback(
    (open: boolean) => {
      if (!open) {
        flushPreviewSave();
        setPreviewPageId(null);
        previewJustClosedRef.current = true;
        requestAnimationFrame(() => {
          previewJustClosedRef.current = false;
        });
      }
    },
    [flushPreviewSave],
  );

  // Compute query range based on view
  const { start, end } = useMemo(() => {
    if (viewMode === "week") return getWeekRange(selectedDate);
    return getDayRange(selectedDate);
  }, [selectedDate, viewMode]);

  const weekDays = useMemo(() => getWeekDays(selectedDate), [selectedDate]);

  const { data: pages } = useGetCalendarPages(activeSpaceId, start, end);

  const { mutate: createPage } = useCreatePage({
    onSuccess: (newPage) => {
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      setPreviewPageId(newPage.id);
    },
  });

  const { mutate: updatePage } = useUpdatePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["page", previewPageId] });
    },
  });

  const handlePreviewScheduleChange = useCallback(
    (scheduledAt: number, duration: number | null) => {
      if (!previewPageId) return;
      updatePage({ id: previewPageId, scheduledAt, duration });
    },
    [previewPageId, updatePage],
  );

  const createPageAtTime = useCallback(
    (startMinutes: number, durationMinutes: number, date?: Date) => {
      if (!activeSpaceId) return;
      const scheduledDate = new Date(date || selectedDate);
      scheduledDate.setHours(0, 0, 0, 0);
      scheduledDate.setMinutes(startMinutes);
      createPage({
        title: "",
        parentId: null,
        spaceId: activeSpaceId,
        scheduledAt: scheduledDate.getTime(),
        duration: durationMinutes,
      });
    },
    [activeSpaceId, selectedDate, createPage],
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
    return { timedPages, allDayPages };
  }, [pages]);

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
      // Find all column wrappers and determine which one the pointer is over by X
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

      // Use target day if dragged to a different column, otherwise keep original day
      const targetDate = dragTargetDay || new Date(activeDragPage.scheduledAt);
      const scheduledDate = new Date(targetDate);
      scheduledDate.setHours(0, 0, 0, 0);
      scheduledDate.setMinutes(newStartMin);

      const changed = scheduledDate.getTime() !== activeDragPage.scheduledAt;
      if (changed) {
        updatePage({
          id: activeDragPage.id,
          scheduledAt: scheduledDate.getTime(),
        });
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
      // Don't exceed day end
      const maxDuration = TOTAL_HOURS * 60 - resize.originalStartMin;
      setResizeDuration(Math.min(newDuration, maxDuration));
    }

    function handlePointerUp() {
      if (
        resize &&
        resizeDuration !== null &&
        resizeDuration !== resize.originalDuration
      ) {
        updatePage({
          id: resize.pageId,
          duration: resizeDuration,
        });
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

  function getMinutesFromMouseEvent(
    e: React.MouseEvent | MouseEvent,
    columnEl?: HTMLElement,
  ): number {
    const el = columnEl || gridRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const y = e.clientY - rect.top;
    return Math.max(
      0,
      Math.min(pxToMinutes(y), TOTAL_HOURS * 60 - SNAP_MINUTES),
    );
  }

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
    if (previewPageId || previewJustClosedRef.current) return;
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
    const minutes = getMinutesFromMouseEvent(e, columnEl || undefined);

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
      // Use grid ref for y calculation in both views
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
        e.target instanceof HTMLTextAreaElement
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
  }, [createPageAtTime, viewMode]);

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
        {/* Event cards */}
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
            onEventClick={setPreviewPageId}
            compact={viewMode === "week"}
          />
        ))}

        {/* Move-drag ghost */}
        {activeDragPage &&
          (() => {
            // Show ghost on the target column (or original column if no target yet)
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

  return (
    <div className={style.container}>
      <div className={style.header}>
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
        <div className={style.viewToggle}>
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
      </div>

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
                  onEventClick={setPreviewPageId}
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
                  {/* Hour gridlines */}
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

        <DragOverlay dropAnimation={null}>
          {activeDragPage && (
            <EventOverlay
              page={activeDragPage}
              deltaMinutes={dragDeltaMinutes}
            />
          )}
        </DragOverlay>
      </DndContext>

      {/* Event preview — Drawer on mobile, Dialog on desktop */}
      {isMobile ? (
        <Drawer open={previewPageId !== null} onOpenChange={handlePreviewClose} modal={false}>
          <DrawerContent className="h-[90vh] flex flex-col p-0">
            <div className={style.previewHeader}>
              <PreviewScheduleControls
                scheduledAt={previewPage?.scheduledAt ?? null}
                duration={previewPage?.duration ?? null}
                onChange={handlePreviewScheduleChange}
              />
              <Link
                to={`/page/${previewPageId}`}
                className={style.previewOpenLink}
              >
                <Maximize2 size={14} />
                {t("Open page")}
              </Link>
            </div>
            <div className="flex-1 overflow-hidden">
              {isPreviewLoading || !editorReady ? (
                <div className={style.previewLoading}>{t("Loading...")}</div>
              ) : previewPage?.snapshot && previewPageId ? (
                <MountedEditor
                  snapshot={previewPage.snapshot}
                  pageId={previewPageId}
                  snapshotClock={previewPage.snapshotClock}
                  onContentChange={handlePreviewContentChange}
                  className="h-full"
                  autoFocus
                  padding={{
                    paddingTop: 8,
                    paddingBottom: 16,
                    paddingLeft: 12,
                    paddingRight: 12,
                  }}
                />
              ) : null}
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <Dialog open={previewPageId !== null} onOpenChange={handlePreviewClose} modal={false}>
          <DialogContent className="sm:max-w-3xl h-[70vh] flex flex-col p-0 gap-0">
            <DialogTitle className="sr-only">
              {previewPage?.title || t("Untitled")}
            </DialogTitle>
            <div className={style.previewHeader}>
              <PreviewScheduleControls
                scheduledAt={previewPage?.scheduledAt ?? null}
                duration={previewPage?.duration ?? null}
                onChange={handlePreviewScheduleChange}
              />
              <Link
                to={`/page/${previewPageId}`}
                className={style.previewOpenLink}
              >
                <Maximize2 size={14} />
                {t("Open page")}
              </Link>
            </div>
            <div className="flex-1 overflow-hidden">
              {isPreviewLoading || !editorReady ? (
                <div className={style.previewLoading}>{t("Loading...")}</div>
              ) : previewPage?.snapshot && previewPageId ? (
                <MountedEditor
                  snapshot={previewPage.snapshot}
                  pageId={previewPageId}
                  snapshotClock={previewPage.snapshotClock}
                  onContentChange={handlePreviewContentChange}
                  className="h-full"
                  autoFocus
                  padding={{
                    paddingTop: 8,
                    paddingBottom: 16,
                    paddingLeft: 12,
                    paddingRight: 12,
                  }}
                />
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
