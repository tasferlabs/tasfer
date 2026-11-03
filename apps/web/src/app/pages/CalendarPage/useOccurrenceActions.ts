import { useCallback, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  deletePage,
  getPage,
  restorePage,
  splitSeries,
  updateOccurrence,
  updatePage,
  type ICalendarPage,
} from "../../api/pages.api";
import {
  endRuleBefore,
  formatRecurrence,
  occurrenceKey,
  parseRecurrence,
  shiftOccurrenceKey,
  shiftRule,
} from "@/platform/recurrence";
import type { CalendarUndoEntry } from "./useCalendarUndo";
import { useRecurrenceScope } from "./RecurrenceScopeDialog";

/** A schedule change made to one calendar entry. */
export interface EntryScheduleChange {
  scheduledAt?: string;
  duration?: number | null;
  allDay?: boolean | null;
}

/** The undo/redo toasts for a change, already translated. */
export interface ChangeMessages {
  undoMessage: string;
  redoMessage: string;
}

/** Whether a calendar entry is one occurrence of a repeating event. */
export function isOccurrence(
  entry: ICalendarPage | null | undefined,
): entry is ICalendarPage & {
  seriesId: string;
  occurrenceStart: string;
  seriesStart: string;
} {
  return !!entry?.seriesId && !!entry.occurrenceStart && !!entry.seriesStart;
}

function isFirstOccurrence(entry: {
  occurrenceStart: string;
  seriesStart: string;
}): boolean {
  return (
    occurrenceKey(entry.occurrenceStart) === occurrenceKey(entry.seriesStart)
  );
}

/**
 * Moving, resizing, and archiving occurrences of repeating events. Each asks
 * which occurrences the change covers, then:
 *
 * - This event: an override on that occurrence alone.
 * - All events: the series itself changes, and the engine carries every
 *   occurrence's own changes and notes along with it.
 * - This and following: the series is split at the occurrence (the old one
 *   ends just before it) and the change goes to the new series.
 */
export function useOccurrenceActions({
  recordUndo,
  onArchived,
}: {
  recordUndo: (entry: CalendarUndoEntry) => void;
  /** Called after occurrences were archived, so the host can close views. */
  onArchived?: (entry: ICalendarPage) => void;
}): {
  reschedule: (
    entry: ICalendarPage,
    change: EntryScheduleChange,
    messages: ChangeMessages,
  ) => Promise<void>;
  archive: (entry: ICalendarPage) => Promise<void>;
  scopeDialog: ReactNode;
} {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [promptScope, scopeDialog] = useRecurrenceScope();

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
    queryClient.invalidateQueries({ queryKey: ["pages"] });
    queryClient.invalidateQueries({ queryKey: ["page"] });
  }, [queryClient]);

  // Paint a one-occurrence change into the calendar now, as the grid's other
  // edits do, rather than leaving the card where it was until the refetch.
  const patchEntry = useCallback(
    (id: string, change: EntryScheduleChange) => {
      queryClient.setQueriesData<ICalendarPage[]>(
        { queryKey: ["calendar-pages"] },
        (old) =>
          old?.map((p) =>
            p.id === id
              ? {
                  ...p,
                  ...(change.scheduledAt !== undefined && {
                    scheduledAt: change.scheduledAt,
                  }),
                  ...(change.duration !== undefined && {
                    duration: change.duration,
                  }),
                  ...(change.allDay !== undefined && { allDay: change.allDay }),
                }
              : p,
          ),
      );
    },
    [queryClient],
  );

  const reschedule = useCallback(
    async (
      entry: ICalendarPage,
      change: EntryScheduleChange,
      messages: ChangeMessages,
    ) => {
      if (!isOccurrence(entry)) return;
      const scope = await promptScope(
        "change",
        isFirstOccurrence(entry),
        entry.task,
      );
      if (!scope) return;
      const { seriesId, occurrenceStart } = entry;

      if (scope === "this") {
        const before: EntryScheduleChange = {};
        const after: EntryScheduleChange = {};
        if (change.scheduledAt !== undefined) {
          // Back on its own slot, it follows the series again.
          before.scheduledAt =
            occurrenceKey(entry.scheduledAt) === occurrenceKey(occurrenceStart)
              ? undefined
              : entry.scheduledAt;
          after.scheduledAt = change.scheduledAt;
        }
        if (change.duration !== undefined) {
          before.duration = entry.duration;
          after.duration = change.duration;
        }
        if (change.allDay !== undefined) {
          before.allDay = entry.allDay;
          after.allDay = change.allDay;
        }
        const write = (fields: EntryScheduleChange) =>
          updateOccurrence({
            seriesId,
            occurrenceStart,
            ...fields,
            ...("scheduledAt" in fields && {
              scheduledAt: fields.scheduledAt ?? null,
            }),
          }).then(refresh);
        patchEntry(entry.id, change);
        await write(after);
        recordUndo({
          ...messages,
          pageId: seriesId,
          undo: () => write(before),
          redo: () => write(after),
        });
        return;
      }

      // "All" and "following" change a series. Splitting first makes the
      // occurrence the start of a new one, so both end up as "all events" of
      // some series.
      let targetId = seriesId;
      let targetStart = entry.seriesStart;
      if (scope === "following" && !isFirstOccurrence(entry)) {
        targetId = await splitSeries(seriesId, occurrenceStart);
        targetStart = occurrenceKey(occurrenceStart);
      }
      const series = await getPage(targetId);
      const rule = parseRecurrence(series.recurrence);
      if (!rule) return;

      // This occurrence now follows the series; drop its own values for what
      // changed, or they would keep it where it was.
      await updateOccurrence({
        seriesId: targetId,
        occurrenceStart,
        ...(change.scheduledAt !== undefined && { scheduledAt: null }),
        ...(change.duration !== undefined && { duration: null }),
        ...(change.allDay !== undefined && { allDay: null }),
      });

      const before = {
        id: targetId,
        scheduledAt: targetStart,
        duration: series.duration ?? null,
        allDay: series.allDay ?? null,
        recurrence: series.recurrence ?? null,
      };
      const after = { ...before };
      if (change.scheduledAt !== undefined) {
        // The same move, applied to the series' first start: as many days
        // later, at the new clock time.
        after.scheduledAt = shiftOccurrenceKey(
          targetStart,
          entry.scheduledAt,
          change.scheduledAt,
          rule.tzid,
        );
        after.recurrence = formatRecurrence(
          shiftRule(rule, targetStart, after.scheduledAt),
        );
      }
      if (change.duration !== undefined) after.duration = change.duration;
      if (change.allDay !== undefined) after.allDay = change.allDay;

      await updatePage(after);
      refresh();
      // Undoing a split would also have to fold the new series back, moving
      // its notes pages home; that is not offered, so only "all" is undoable.
      if (targetId === seriesId) {
        recordUndo({
          ...messages,
          pageId: targetId,
          undo: () => updatePage(before).then(refresh),
          redo: () => updatePage(after).then(refresh),
        });
      }
    },
    [promptScope, patchEntry, recordUndo, refresh],
  );

  const archive = useCallback(
    async (entry: ICalendarPage) => {
      if (!isOccurrence(entry)) return;
      const first = isFirstOccurrence(entry);
      const scope = await promptScope("archive", first, entry.task);
      if (!scope) return;
      const { seriesId, occurrenceStart } = entry;

      if (scope === "this") {
        const write = (cancelled: boolean | null) =>
          updateOccurrence({ seriesId, occurrenceStart, cancelled }).then(
            refresh,
          );
        await write(true);
        recordUndo({
          undoMessage: t(
            "calendar.undo.occurrenceArchiveUndone",
            "Page brought back",
          ),
          redoMessage: t(
            "calendar.undo.occurrenceArchiveRedone",
            "Page archived again",
          ),
          pageId: seriesId,
          undo: () => write(null),
          redo: () => write(true),
        });
      } else if (scope === "following" && !first) {
        const series = await getPage(seriesId);
        const rule = parseRecurrence(series.recurrence);
        if (!rule) return;
        const before = series.recurrence ?? null;
        const after = formatRecurrence(endRuleBefore(rule, occurrenceStart));
        const write = (recurrence: string | null) =>
          updatePage({ id: seriesId, recurrence }).then(refresh);
        await write(after);
        recordUndo({
          undoMessage: t(
            "calendar.undo.followingArchiveUndone",
            "Pages brought back",
          ),
          redoMessage: t(
            "calendar.undo.followingArchiveRedone",
            "Pages archived again",
          ),
          pageId: seriesId,
          undo: () => write(before),
          redo: () => write(after),
        });
      } else {
        // The series page goes to the Timeline with every occurrence's notes
        // nested under it, all restorable together.
        await deletePage({ id: seriesId });
        refresh();
        recordUndo({
          undoMessage: t(
            "calendar.undo.archiveUndone",
            "Page restored from the Timeline",
          ),
          redoMessage: t("calendar.undo.archiveRedone", "Page archived again"),
          pageId: seriesId,
          undo: () => restorePage({ id: seriesId }).then(refresh),
          redo: () => deletePage({ id: seriesId }).then(refresh),
        });
      }
      onArchived?.(entry);
    },
    [promptScope, recordUndo, refresh, onArchived, t],
  );

  return { reschedule, archive, scopeDialog };
}
