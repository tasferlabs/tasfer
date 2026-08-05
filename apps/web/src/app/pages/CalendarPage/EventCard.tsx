import { useEffect, useRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Archive, ChevronLeft, ChevronRight, Copy, Pencil } from "lucide-react";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { ICalendarPage } from "../../api/pages.api";
import { TitlePreview } from "../../TitlePreview";
import {
  DEFAULT_HOUR_HEIGHT,
  pageToStartMin,
  formatEventTime,
  formatTime,
  getEventLaneInsets,
  type CalendarEventLayout,
} from "./utils";
import style from "./CalendarPage.module.css";

// Below this the card can't fit a legible line of text, so it collapses to a
// coloured dot instead of a strip of clipped glyphs.
const DOT_ONLY_HEIGHT = 14;
// Below this even the ellipsis won't fit; the bare coloured band stands in.
const ELLIPSIS_MIN_HEIGHT = 10;
// Below this a title still fits, but only without the card's bottom padding.
const TIGHT_HEIGHT = 24;

export function EventCard({
  page,
  onResizeStart,
  onEventClick,
  onDuplicate,
  onDelete,
  layout,
  compact,
  isDraft,
  hourHeight = DEFAULT_HOUR_HEIGHT,
}: {
  page: ICalendarPage;
  onResizeStart: (pageId: string, e: React.PointerEvent) => void;
  onEventClick: (pageId: string, rect: DOMRect) => void;
  onDuplicate?: (pageId: string) => void;
  onDelete?: (pageId: string) => void;
  layout?: CalendarEventLayout;
  compact?: boolean;
  isDraft?: boolean;
  hourHeight?: number;
}) {
  const { t } = useTranslation();
  const startMin = pageToStartMin(page);
  const duration = page.duration || 60;
  const top = (startMin / 60) * hourHeight;
  const height = (duration / 60) * hourHeight;

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `event-${page.id}`,
    data: { page },
  });

  const timeStr = formatEventTime(page.scheduledAt, page.duration);
  const dotOnly = height < DOT_ONLY_HEIGHT;
  const showEllipsis = dotOnly && height >= ELLIPSIS_MIN_HEIGHT;
  const tight = !dotOnly && height < TIGHT_HEIGHT;
  const showTimeSeparate = height > 40;
  const showTimeInline = !showTimeSeparate && height > 25;
  const showPath = page.path && height > 55;

  const accent =
    page.color ??
    (page.path && [...page.path].reverse().find((p) => p.color)?.color) ??
    null;
  const accentColor =
    accent && !isDraft ? accent : "var(--page-color-default)";
  const titleFontSize = tight ? "0.65rem" : compact ? "0.7rem" : undefined;
  const titleMathSize = tight ? 10 : compact ? 11 : 12;

  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // The card keeps `touch-action: none` so the browser can't steal the gesture
  // and cancel dnd-kit's press before the move-drag arms. Scroll still wins:
  // until the drag activates, vertical movement is forwarded to the timeline
  // here, with a fling on release to match native momentum.
  const panRef = useRef<{
    scroller: HTMLElement;
    lastY: number;
    lastT: number;
    velocity: number;
  } | null>(null);
  const flingRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  draggingRef.current = isDragging;

  const stopFling = () => {
    if (flingRef.current !== null) cancelAnimationFrame(flingRef.current);
    flingRef.current = null;
  };
  useEffect(() => stopFling, []);

  const card = (
    <div
      ref={(node) => {
        cardRef.current = node;
        setNodeRef(node);
      }}
      className={clsx(
        style.eventCard,
        isDraft && style.eventCardDraft,
        tight && style.eventCardTight,
        dotOnly && style.eventCardDot,
      )}
      {...(isDraft ? { "data-draft-card": "" } : {})}
      {...(dotOnly
        ? {
            "aria-label": `${page.title || t("common.untitled", "Untitled")} — ${timeStr}`,
          }
        : {})}
      style={{
        top,
        height,
        opacity: isDragging ? 0.3 : 1,
        borderInlineStartColor: accentColor,
        ...getEventLaneInsets(layout, !!compact),
        ...(compact && !dotOnly
          ? { padding: tight ? "0 6px" : "2px 6px" }
          : {}),
      }}
      {...listeners}
      {...attributes}
      onPointerDown={(e) => {
        pointerStartRef.current = { x: e.clientX, y: e.clientY };
      }}
      onTouchStart={(e) => {
        stopFling();
        const scroller =
          e.touches.length === 1 ? findScroller(e.currentTarget) : null;
        panRef.current = scroller
          ? { scroller, lastY: e.touches[0].clientY, lastT: e.timeStamp, velocity: 0 }
          : null;
        listeners?.onTouchStart?.(e as any);
      }}
      onTouchMove={(e) => {
        const pan = panRef.current;
        // A second finger belongs to the timeline's zoom gesture, and once the
        // drag has armed the card follows the finger instead of scrolling.
        if (!pan || draggingRef.current || e.touches.length !== 1) {
          panRef.current = null;
          return;
        }
        const y = e.touches[0].clientY;
        const dt = e.timeStamp - pan.lastT;
        pan.scroller.scrollTop += pan.lastY - y;
        if (dt > 0) pan.velocity = (pan.lastY - y) / dt;
        pan.lastY = y;
        pan.lastT = e.timeStamp;
      }}
      onTouchEnd={() => {
        const pan = panRef.current;
        panRef.current = null;
        if (!pan || draggingRef.current || Math.abs(pan.velocity) < 0.05) return;
        let velocity = pan.velocity;
        let last = performance.now();
        const step = (now: number) => {
          const dt = now - last;
          last = now;
          velocity *= Math.pow(0.94, dt / 16);
          if (Math.abs(velocity) < 0.02) return stopFling();
          pan.scroller.scrollTop += velocity * dt;
          flingRef.current = requestAnimationFrame(step);
        };
        flingRef.current = requestAnimationFrame(step);
      }}
      onTouchCancel={() => {
        panRef.current = null;
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
      {dotOnly ? (
        showEllipsis ? <span className={style.eventEllipsis}>…</span> : null
      ) : showTimeInline && compact ? (
        <div className={style.eventInline}>
          <span className={style.eventTitle} style={{ fontSize: titleFontSize }}>
            <TitlePreview
              title={page.title}
              titleMd={page.titleMd}
              mathFontSize={titleMathSize}
            />
          </span>
          <span className={style.eventTimeInline}>{formatTime(startMin)}</span>
        </div>
      ) : (
        <>
          <span
            className={style.eventTitle}
            style={titleFontSize ? { fontSize: titleFontSize } : undefined}
          >
            <TitlePreview
              title={page.title}
              titleMd={page.titleMd}
              mathFontSize={titleMathSize}
            />
          </span>
          {showTimeSeparate && (
            <div
              className={style.eventTime}
              style={compact ? { fontSize: "0.6rem" } : undefined}
            >
              {timeStr}
            </div>
          )}
          {showPath && <PathBreadcrumb path={page.path!} compact={compact} />}
        </>
      )}
      {/* A handle taller than the card would swallow the tap target, so it
          tracks the card height and disappears once only a dot is left. */}
      {!dotOnly && (
        <div
          className={style.resizeHandle}
          style={
            tight ? { height: Math.max(4, Math.round(height / 3)) } : undefined
          }
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart(page.id, e);
          }}
          // A press fires more than pointerdown (handled above): touchstart on
          // touch, mousedown with a mouse. Either one bubbling to the card trips
          // dnd-kit, moving the event while it resizes.
          onTouchStart={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );

  if (isDraft || !onDuplicate || !onDelete) return card;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            const rect = cardRef.current?.getBoundingClientRect();
            if (rect) onEventClick(page.id, rect);
          }}
        >
          <Pencil />
          {t("common.edit", "Edit")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onDuplicate(page.id)}>
          <Copy />
          {t("calendar.duplicateEvent", "Duplicate page")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onDelete(page.id)}>
          <Archive />
          {t("calendar.archiveEvent", "Archive page")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function findScroller(from: HTMLElement): HTMLElement | null {
  for (let el = from.parentElement; el; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === "auto" || overflow === "scroll") return el;
  }
  return null;
}

function PathBreadcrumb({
  path,
  compact,
}: {
  path: { id: string; title: string }[];
  compact?: boolean;
}) {
  const collapsed = path.length > 2;
  const Chevron = i18next.dir() === "rtl" ? ChevronLeft : ChevronRight;

  return (
    <div
      className={style.eventPath}
      style={compact ? { fontSize: "0.55rem" } : undefined}
    >
      {collapsed ? (
        <>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "5rem",
            }}
          >
            {path[0].title}
          </span>
          <Chevron size={8} style={{ flexShrink: 0, opacity: 0.5 }} />
          <span style={{ flexShrink: 0 }}>…</span>
          <Chevron size={8} style={{ flexShrink: 0, opacity: 0.5 }} />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "5rem",
            }}
          >
            {path[path.length - 1].title}
          </span>
        </>
      ) : (
        path.map((segment, i) => (
          <span
            key={segment.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              minWidth: 0,
            }}
          >
            {i > 0 && (
              <Chevron size={8} style={{ flexShrink: 0, opacity: 0.5 }} />
            )}
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "7rem",
              }}
            >
              {segment.title}
            </span>
          </span>
        ))
      )}
    </div>
  );
}
