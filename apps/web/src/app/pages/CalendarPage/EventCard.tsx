import { useRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import type { ICalendarPage } from "../../api/pages.api";
import {
  HOUR_HEIGHT,
  pageToStartMin,
  formatEventTime,
  formatTime,
} from "./utils";
import style from "./CalendarPage.module.css";

export function EventCard({
  page,
  onResizeStart,
  onEventClick,
  compact,
  isDraft,
}: {
  page: ICalendarPage;
  onResizeStart: (pageId: string, e: React.PointerEvent) => void;
  onEventClick: (pageId: string, rect: DOMRect) => void;
  compact?: boolean;
  isDraft?: boolean;
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

  const actualHeight = Math.max(height, 20);
  const timeStr = formatEventTime(page.scheduledAt, page.duration);
  const showTimeSeparate = actualHeight > 40;
  const showTimeInline = !showTimeSeparate && actualHeight > 25;

  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={setNodeRef}
      className={`${style.eventCard}${isDraft ? ` ${style.eventCardDraft}` : ""}`}
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
        listeners?.onPointerDown?.(e as any);
      }}
      onClick={(e) => {
        if (!pointerStartRef.current) return;
        const dx = e.clientX - pointerStartRef.current.x;
        const dy = e.clientY - pointerStartRef.current.y;
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
          const card = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onEventClick(page.id, card);
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
