import { useMemo, useRef } from "react";
import { Archive, Copy, Pencil, Square, SquareCheck } from "lucide-react";
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
import { DoneBox } from "./EventCard";
import { formatDate, layoutAllDayRow, type AllDaySpan } from "./utils";
import style from "./CalendarPage.module.css";

/**
 * The row above the hour grid where all-day events sit, one column per day in
 * view. A click on an empty part of a day starts a new all-day event there.
 */
export function AllDayRow({
  days,
  pages,
  canCreate,
  onCreate,
  onEventClick,
  onDuplicate,
  onDelete,
  onToggleDone,
}: {
  days: Date[];
  pages: ICalendarPage[];
  /** Read when the press starts, before a click outside closes an open preview. */
  canCreate: () => boolean;
  onCreate: (day: Date) => void;
  onEventClick: (pageId: string, rect: DOMRect) => void;
  onDuplicate: (pageId: string) => void;
  onDelete: (pageId: string) => void;
  onToggleDone: (pageId: string) => void;
}) {
  const { t } = useTranslation();
  const spans = useMemo(() => layoutAllDayRow(pages, days), [pages, days]);
  const laneCount = spans.reduce((n, s) => Math.max(n, s.lane + 1), 0);
  // Whether the press that ends in a click may create. A press that closes the
  // open preview only dismisses it, as it does on the hour grid.
  const createArmedRef = useRef(false);

  return (
    <div className={style.allDayRow}>
      <div className={style.allDayLabel}>{t("calendar.allDay", "All day")}</div>
      <div
        className={style.allDayGrid}
        style={{
          gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${Math.max(1, laneCount)}, auto)`,
        }}
      >
        {days.map((day, i) => (
          <button
            key={i}
            type="button"
            className={style.allDayCell}
            style={{ gridColumn: i + 1, gridRow: "1 / -1" }}
            aria-label={`${t("calendar.newAllDayPage", "New all-day page")}, ${formatDate(day)}`}
            title={t("calendar.newAllDayPage", "New all-day page")}
            onPointerDown={() => {
              createArmedRef.current = canCreate();
            }}
            onClick={(e) => {
              // A keyboard press (Enter/Space) has no pointerdown to arm it.
              const armed = e.detail === 0 ? canCreate() : createArmedRef.current;
              createArmedRef.current = false;
              if (armed) onCreate(day);
            }}
          />
        ))}
        {spans.map((span) => (
          <AllDayChip
            key={span.page.id}
            span={span}
            onEventClick={onEventClick}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            onToggleDone={onToggleDone}
          />
        ))}
      </div>
    </div>
  );
}

function AllDayChip({
  span,
  onEventClick,
  onDuplicate,
  onDelete,
  onToggleDone,
}: {
  span: AllDaySpan;
  onEventClick: (pageId: string, rect: DOMRect) => void;
  onDuplicate: (pageId: string) => void;
  onDelete: (pageId: string) => void;
  onToggleDone: (pageId: string) => void;
}) {
  const { t } = useTranslation();
  const { page } = span;
  const isDraft = page.id === "__draft__";
  const isTask = page.task && !isDraft;
  const done = isTask && page.done;
  const doneLabel = done
    ? t("calendar.markNotDone", "Mark not done")
    : t("calendar.markDone", "Mark done");
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const accent = isDraft
    ? null
    : (page.color ??
      (page.path && [...page.path].reverse().find((p) => p.color)?.color) ??
      null);
  const open = () => {
    const rect = chipRef.current?.getBoundingClientRect();
    if (rect) onEventClick(page.id, rect);
  };

  const chip = (
    <button
      ref={chipRef}
      type="button"
      className={clsx(
        style.allDayChip,
        isDraft && style.allDayChipDraft,
        span.continuesBefore && style.allDayChipContinuesBefore,
        span.continuesAfter && style.allDayChipContinuesAfter,
        done && style.allDayChipDone,
      )}
      {...(isDraft ? { "data-draft-card": "" } : {})}
      style={{
        gridColumn: `${span.startCol + 1} / ${span.endCol + 1}`,
        gridRow: span.lane + 1,
        ...(accent
          ? {
              backgroundColor: `color-mix(in srgb, ${accent}, transparent 85%)`,
              // A done task's title fades instead of taking the colour.
              ...(!done && { color: accent }),
            }
          : {}),
      }}
      onClick={open}
    >
      {isTask && <DoneBox done={done} label={doneLabel} />}
      {isDraft ? null : (
        <TitlePreview
          title={page.title}
          titleMd={page.titleMd}
          mathFontSize={11}
        />
      )}
    </button>
  );

  if (isDraft) return chip;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{chip}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={open}>
          <Pencil />
          {t("common.edit", "Edit")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onDuplicate(page.id)}>
          <Copy />
          {t("calendar.duplicateEvent", "Duplicate page")}
        </ContextMenuItem>
        {isTask && (
          <ContextMenuItem onSelect={() => onToggleDone(page.id)}>
            {done ? <Square /> : <SquareCheck />}
            {doneLabel}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onDelete(page.id)}>
          <Archive />
          {t("calendar.archiveEvent", "Archive page")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
