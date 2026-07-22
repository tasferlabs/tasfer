import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from "@/components/ui/popover";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { DateTime } from "luxon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getLuxon, padValue, plusDatetime } from "./utils";
import { TimePicker } from "./TimePicker";
import { YearPicker } from "./YearPicker";
import { getWeekStart, formatDatePreferred } from "@/lib/dateTimePreferences";

export function DateTimePickerOverlay({
  open,
  onClose,
  selectedYear,
  selectedMonth,
  selectedDay,
  setSelectedYear,
  setSelectedMonth,
  setSelectedDay,
  value,
  id: _id,
  selectedHour,
  selectedMinute,
  setSelectedHour,
  setSelectedMinute,
  timezone,
  type,
  maxDate,
  minDate,
  activateTodayButton = true,
}: {
  open: boolean;
  onClose: () => void;
  selectedYear: string;
  selectedMonth: string;
  selectedDay: string;
  setSelectedYear: (year: string) => void;
  setSelectedMonth: (month: string) => void;
  setSelectedDay: (day: string) => void;
  selectedHour: string;
  selectedMinute: string;
  setSelectedHour: (hour: string) => void;
  setSelectedMinute: (minute: string) => void;
  value: string | null;
  id: string;
  timezone: string;
  type: "date" | "datetime" | "time";
  maxDate: string;
  minDate: string;
  activateTodayButton?: boolean;
}) {
  const { t } = useTranslation();
  const datePickerGridRef = useRef(null);
  const dayButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const shouldFocusDayRef = useRef(false);
  const [currentTab, setCurrentTab] = useState<"date" | "time">(
    type === "datetime" || type === "date" ? "date" : "time",
  );

  // Selection staged inside the overlay; only committed to the host state via
  // Apply. Cancel or dismissing the overlay discards it. Empty fields are
  // seeded from the current moment so the pickers always have a selection.
  const [stagedYear, setStagedYear] = useState(selectedYear);
  const [stagedMonth, setStagedMonth] = useState(selectedMonth);
  const [stagedDay, setStagedDay] = useState(selectedDay);
  const [stagedHour, setStagedHour] = useState(selectedHour);
  const [stagedMinute, setStagedMinute] = useState(selectedMinute);

  const handleApply = () => {
    if (type !== "time") {
      setSelectedYear(stagedYear);
      setSelectedMonth(stagedMonth);
      setSelectedDay(stagedDay);
    }
    if (type !== "date") {
      setSelectedHour(stagedHour);
      setSelectedMinute(stagedMinute);
    }
    onClose();
  };

  // React to viewport changes so the picker swaps between the mobile dialog and
  // desktop popover on resize/rotation instead of only at first render.
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(min-width: 600px)").matches
      : true,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 600px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    setIsDesktop(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const [yearView, setYearView] = useState(false);
  const [displayedDate, setDisplayedDate] = useState(() => {
    if (value) {
      return value;
    }
    return DateTime.now().setZone(timezone).toISO() || "";
  });
  const [focusedISO, setFocusedISO] = useState<string | null>(null);
  const weekStart = getWeekStart();

  const minLuxon = useMemo(
    () => DateTime.fromISO(minDate, { zone: timezone }),
    [minDate, timezone],
  );
  const maxLuxon = useMemo(
    () => DateTime.fromISO(maxDate, { zone: timezone }),
    [maxDate, timezone],
  );

  // The currently staged selection, derived from the padded field values.
  const selectedISO = useMemo(() => {
    if (!stagedYear || !stagedMonth || !stagedDay) return null;
    return `${stagedYear}-${stagedMonth}-${stagedDay}`;
  }, [stagedYear, stagedMonth, stagedDay]);

  const todayISO = useMemo(
    () => DateTime.now().setZone(timezone).toISODate(),
    [timezone],
  );

  const weeks: {
    date: DateTime;
    active: boolean;
    today: boolean;
    disabled: boolean;
    disabledByChoice: boolean;
  }[][] = useMemo(() => {
    const luxonDate = getLuxon(displayedDate, timezone);
    const firstOfMonth = luxonDate.startOf("month");
    // luxon weekday: 1=Mon..7=Sun → convert to JS-style 0=Sun..6=Sat
    const jsWeekday = firstOfMonth.weekday % 7;
    const offset = (jsWeekday - weekStart + 7) % 7;
    const gridStart = firstOfMonth.minus({ days: offset });
    return Array(6)
      .fill(Array(7).fill(0))
      .map((week, i) =>
        week.map((_: number, j: number) => {
          const date = gridStart.plus({ days: 7 * i + j });
          const iso = date.toISODate();
          return {
            date,
            active: selectedISO !== null && iso === selectedISO,
            today: iso === todayISO,
            disabledByChoice:
              date.toMillis() < minLuxon.toMillis() ||
              date.toMillis() > maxLuxon.toMillis(),
            disabled: luxonDate.month !== date.month,
          };
        }),
      );
  }, [displayedDate, minLuxon, maxLuxon, weekStart, selectedISO, todayISO, timezone]);

  const displayedLuxon = getLuxon(displayedDate, timezone);
  const inDisplayedMonth = useCallback(
    (iso: string | null) => {
      if (!iso) return false;
      const d = DateTime.fromISO(iso, { zone: timezone });
      return d.month === displayedLuxon.month && d.year === displayedLuxon.year;
    },
    [displayedLuxon.month, displayedLuxon.year, timezone],
  );

  // Roving-tabindex target: the single day reachable via Tab. Prefer the
  // keyboard-focused day, then the selection, then today, then the 1st.
  const tabbableISO = useMemo(() => {
    if (focusedISO && inDisplayedMonth(focusedISO)) return focusedISO;
    if (selectedISO && inDisplayedMonth(selectedISO)) return selectedISO;
    if (todayISO && inDisplayedMonth(todayISO)) return todayISO;
    return displayedLuxon.startOf("month").toISODate();
  }, [focusedISO, selectedISO, todayISO, inDisplayedMonth, displayedLuxon]);

  // Whether paging to the previous/next month stays within [minDate, maxDate].
  const canGoPrevMonth =
    displayedLuxon.startOf("month").minus({ days: 1 }).toMillis() >=
    minLuxon.startOf("day").toMillis();
  const canGoNextMonth =
    displayedLuxon.endOf("month").plus({ days: 1 }).toMillis() <=
    maxLuxon.endOf("day").toMillis();

  const handleDaySelect = (date: DateTime) => {
    setStagedDay(padValue(date.day.toString(), "day"));
    setStagedMonth(padValue(date.month.toString(), "month"));
    setStagedYear(padValue(date.year.toString(), "year"));
    if (type === "datetime") {
      setCurrentTab("time");
    }
  };

  useEffect(() => {
    if (open) {
      const nextTab = type === "datetime" || type === "date" ? "date" : "time";
      setCurrentTab(nextTab);
      // Re-stage from the committed selection, defaulting empty fields to now.
      const now = DateTime.now().setZone(timezone);
      setStagedYear(selectedYear || padValue(String(now.year), "year"));
      setStagedMonth(selectedMonth || padValue(String(now.month), "month"));
      setStagedDay(selectedDay || padValue(String(now.day), "day"));
      setStagedHour(selectedHour || padValue(String(now.hour), "hour"));
      setStagedMinute(
        selectedMinute || (selectedHour ? "00" : padValue(String(now.minute), "minute")),
      );
      // Seed the keyboard-focus target so Tab/arrows land on the selection, and
      // pull focus onto that day once the grid renders.
      if (nextTab === "date") {
        const committedISO =
          selectedYear && selectedMonth && selectedDay
            ? `${selectedYear}-${selectedMonth}-${selectedDay}`
            : null;
        setFocusedISO(committedISO ?? displayedLuxon.toISODate());
        shouldFocusDayRef.current = true;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (value) {
      setDisplayedDate(value);
    }
  }, [value]);

  // Move DOM focus onto the keyboard-focused day after it renders (including
  // after a month change caused by arrowing across a boundary).
  useEffect(() => {
    if (!shouldFocusDayRef.current || !focusedISO || !open || yearView) return;
    const btn = dayButtonRefs.current.get(focusedISO);
    if (btn) {
      btn.focus();
      shouldFocusDayRef.current = false;
    }
  }, [focusedISO, weeks, open, yearView]);

  const isRtl =
    typeof document !== "undefined" && document.documentElement.dir === "rtl";

  const moveFocusTo = useCallback(
    (target: DateTime) => {
      let clamped = target;
      if (clamped.toMillis() < minLuxon.toMillis()) clamped = minLuxon;
      if (clamped.toMillis() > maxLuxon.toMillis()) clamped = maxLuxon;
      const iso = clamped.toISODate();
      shouldFocusDayRef.current = true;
      setFocusedISO(iso);
      if (
        clamped.month !== displayedLuxon.month ||
        clamped.year !== displayedLuxon.year
      ) {
        setDisplayedDate(clamped.toISO() || "");
      }
    },
    [minLuxon, maxLuxon, displayedLuxon.month, displayedLuxon.year],
  );

  const handleGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const from = focusedISO
      ? DateTime.fromISO(focusedISO, { zone: timezone })
      : getLuxon(displayedDate, timezone);
    if (!from.isValid) return;
    const forward = isRtl ? -1 : 1;
    let next: DateTime | null = null;
    switch (e.key) {
      case "ArrowLeft":
        next = from.plus({ days: -forward });
        break;
      case "ArrowRight":
        next = from.plus({ days: forward });
        break;
      case "ArrowUp":
        next = from.minus({ days: 7 });
        break;
      case "ArrowDown":
        next = from.plus({ days: 7 });
        break;
      case "Home":
        next = from.minus({ days: (from.weekday % 7 === weekStart ? 0 : (from.weekday % 7 - weekStart + 7) % 7) });
        break;
      case "End":
        next = from.plus({ days: 6 - ((from.weekday % 7 - weekStart + 7) % 7) });
        break;
      case "PageUp":
        next = from.minus({ months: 1 });
        break;
      case "PageDown":
        next = from.plus({ months: 1 });
        break;
      default:
        return;
    }
    e.preventDefault();
    moveFocusTo(next);
  };

  // All 7 day labels indexed by JS weekday (0=Sun..6=Sat)
  const allDays = [t("calendar.dayAbbr.su", "Su"), t("calendar.dayAbbr.mo", "Mo"), t("calendar.dayAbbr.tu", "Tu"), t("calendar.dayAbbr.we", "We"), t("calendar.dayAbbr.th", "Th"), t("calendar.dayAbbr.fr", "Fr"), t("calendar.dayAbbr.sa", "Sa")];
  const allDayNames = [t("calendar.dayName.su", "Sunday"), t("calendar.dayName.mo", "Monday"), t("calendar.dayName.tu", "Tuesday"), t("calendar.dayName.we", "Wednesday"), t("calendar.dayName.th", "Thursday"), t("calendar.dayName.fr", "Friday"), t("calendar.dayName.sa", "Saturday")];
  const weekDays = Array.from({ length: 7 }, (_, i) => ({
    abbr: allDays[(weekStart + i) % 7],
    name: allDayNames[(weekStart + i) % 7],
  }));

  const component = (
    <div className="flex flex-col gap-1">
      {type !== "datetime" && (
        <div className="mb-2 border-b border-border pb-2 text-base font-semibold text-foreground">
          {type === "time"
            ? t("timePicker.title", "Select Time")
            : t("datePicker.title", "Select Date")}
        </div>
      )}
      {type === "datetime" && (
        <Tabs
          value={currentTab}
          onValueChange={(v) => setCurrentTab(v as "date" | "time")}
        >
          <div className="px-[0.5rem]">
            <TabsList className="w-full">
              <TabsTrigger value="date" className="flex-1">
                {t("common.date", "Date")}
              </TabsTrigger>
              <TabsTrigger value="time" className="flex-1">
                {t("common.time", "Time")}
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="date">{renderDateContent()}</TabsContent>
          <TabsContent value="time">{renderTimeContent()}</TabsContent>
        </Tabs>
      )}
      {type === "date" && renderDateContent()}
      {type === "time" && renderTimeContent()}
      <div className="mt-2 flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("common.cancel", "Cancel")}
        </Button>
        <Button size="sm" onClick={handleApply}>
          {t("common.apply", "Apply")}
        </Button>
      </div>
    </div>
  );

  function renderTimeContent() {
    return (
      <TimePicker
        selectedHour={stagedHour}
        setSelectedHour={setStagedHour}
        selectedMinute={stagedMinute}
        setSelectedMinute={setStagedMinute}
      />
    );
  }

  function renderDateContent() {
    return (
      <>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center">
            <button
              type="button"
              className="text-base font-medium cursor-pointer hover:text-foreground/80 ps-[0.5rem]"
              aria-expanded={yearView}
              aria-label={t("calendar.toggleYearView", "Switch year")}
              onClick={() => setYearView(!yearView)}
            >
              {formatDatePreferred(getLuxon(displayedDate, timezone).toJSDate(), { month: "long", year: "numeric" })}
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-expanded={yearView}
              aria-label={t("calendar.toggleYearView", "Switch year")}
              onClick={() => setYearView(!yearView)}
              className="ms-1"
            >
              <ChevronDown
                className={cn(
                  "size-4 transition-transform",
                  yearView && "-rotate-180",
                )}
              />
            </Button>
          </div>
          {!yearView && (
            <div className="flex items-center gap-1">
              {activateTodayButton && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-7 px-2"
                  onClick={() => {
                    const today = DateTime.now().setZone(timezone);
                    handleDaySelect(today);
                    setDisplayedDate(today.toISO() || "");
                  }}
                >
                  {t("common.today", "Today")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("calendar.previousMonth", "Previous month")}
                disabled={!canGoPrevMonth}
                onClick={() =>
                  setDisplayedDate(
                    (displayedDate) =>
                      plusDatetime(displayedDate, "month", -1, timezone)!,
                  )
                }
              >
                <ChevronLeft className="size-4 rtl:rotate-180" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("calendar.nextMonth", "Next month")}
                disabled={!canGoNextMonth}
                onClick={() =>
                  setDisplayedDate(
                    (displayedDate) =>
                      plusDatetime(displayedDate, "month", 1, timezone)!,
                  )
                }
              >
                <ChevronRight className="size-4 rtl:rotate-180" />
              </Button>
            </div>
          )}
        </div>
        {yearView ? (
          <YearPicker
            displayedDate={displayedDate}
            setDisplayedDate={setDisplayedDate}
            selectedYear={stagedYear}
            setSelectedYear={setStagedYear}
            setYearView={setYearView}
            timezone={timezone}
            minDate={minDate}
            maxDate={maxDate}
          />
        ) : (
          <div
            ref={datePickerGridRef}
            role="grid"
            aria-label={t("calendar.gridLabel", "Calendar")}
            className="w-full overflow-y-auto"
            onKeyDown={handleGridKeyDown}
          >
            <div role="row" className="flex w-full justify-between">
              {weekDays.map((day) => (
                <div
                  key={day.abbr}
                  role="columnheader"
                  aria-label={day.name}
                  className={cn(
                    "flex-1 flex items-center justify-center p-0.5",
                    isDesktop ? "text-base" : "text-lg",
                  )}
                >
                  <span aria-hidden="true">{day.abbr}</span>
                </div>
              ))}
            </div>
            <div>
              {weeks.map((days, index) => (
                <div key={index} role="row" className="flex justify-between">
                  {days.map(({ date, active, today, disabled, disabledByChoice }) => {
                    const iso = date.toISODate();
                    const isTabbable = iso === tabbableISO;
                    const fullLabel = formatDatePreferred(date.toJSDate(), {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    });
                    return (
                      <div
                        key={date.day}
                        role="gridcell"
                        aria-selected={active}
                        className="aspect-square h-full flex-1 flex items-center justify-center"
                      >
                        <button
                          type="button"
                          tabIndex={isTabbable ? 0 : -1}
                          ref={(el) => {
                            if (el && iso) dayButtonRefs.current.set(iso, el);
                            else if (iso) dayButtonRefs.current.delete(iso);
                          }}
                          aria-label={fullLabel}
                          aria-current={today ? "date" : undefined}
                          onClick={() => handleDaySelect(date)}
                          disabled={disabled || disabledByChoice}
                          className={cn(
                            "aspect-square w-full h-full rounded-full text-base cursor-pointer",
                            active &&
                              "bg-primary text-primary-foreground hover:bg-primary/80",
                            today &&
                              !active &&
                              "ring-1 ring-inset ring-primary/60 font-medium",
                            disabledByChoice &&
                              "text-muted-foreground opacity-50 cursor-not-allowed",
                            disabled &&
                              !disabledByChoice &&
                              "text-muted-foreground opacity-50 cursor-not-allowed",
                            !active &&
                              !disabled &&
                              !disabledByChoice &&
                              "hover:bg-accent",
                          )}
                        >
                          {date.day}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}
      </>
    );
  }

  if (!isDesktop) {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-sm p-4 pt-8">
          <DialogTitle className="sr-only">
            {type === "time" ? t("common.time", "Time") : t("common.date", "Date")}
          </DialogTitle>
          {component}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open={open} onOpenChange={(v) => !v && onClose()}>
      <PopoverAnchor />
      <PopoverContent className="w-auto min-w-[300px] p-2 py-4" align="center">
        {component}
      </PopoverContent>
    </Popover>
  );
}
