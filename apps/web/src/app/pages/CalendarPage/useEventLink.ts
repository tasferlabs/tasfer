import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { zonedWallDate } from "./utils";

/**
 * Open the calendar on one event from a link — `/calendar?event=<id>&at=<iso>`,
 * which is where a clicked reminder lands (see `reminderRoute`). `at` is the
 * entry's start, so the grid can go to its day without looking it up first;
 * `open` gets it as a wall date in the display zone, like `selectedDate`.
 *
 * The parameters are dropped once handled, so going back or reloading does not
 * reopen the event.
 */
export function useEventLink(open: (entryId: string, day: Date) => void) {
  const [params, setParams] = useSearchParams();
  const openRef = useRef(open);
  openRef.current = open;

  const entryId = params.get("event");
  const at = params.get("at");

  useEffect(() => {
    if (!entryId || !at || Number.isNaN(Date.parse(at))) return;
    openRef.current(entryId, zonedWallDate(at));
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("event");
        next.delete("at");
        return next;
      },
      { replace: true },
    );
  }, [entryId, at, setParams]);
}
