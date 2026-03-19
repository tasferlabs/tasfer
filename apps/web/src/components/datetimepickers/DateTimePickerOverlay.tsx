import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from "@/components/ui/popover";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { DateTime } from "luxon";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getLuxon, padValue, plusDatetime } from "./utils";
import { TimePicker } from "./TimePicker";
import { YearPicker } from "./YearPicker";
import { getWeekStart, formatDatePreferred } from "@/lib/dateTimePreferences";

export function DateTimePickerOverlay({
  open,
  onClose,
  selectedYear,
  selectedMonth: _selectedMonth,
  selectedDay: _selectedDay,
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
  activateTodayButton,
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
  const selectedItemRef = useRef<HTMLButtonElement>(null);
  const [currentTab, setCurrentTab] = useState<"date" | "time">(
    type === "datetime" || type === "date" ? "date" : "time",
  );
  const isDesktop =
    typeof window !== "undefined" &&
    window.matchMedia("(min-width: 600px)").matches;

  const [yearView, setYearView] = useState(false);
  const [displayedDate, setDisplayedDate] = useState(() => {
    if (value) {
      return value;
    }
    return DateTime.now().setZone(timezone).toISO() || "";
  });
  const weekStart = getWeekStart();

  const weeks: {
    date: DateTime;
    active: boolean;
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
          return {
            date,
            active: luxonDate.toISODate() === date.toISODate(),
            disabledByChoice:
              date.toMillis() < DateTime.fromISO(minDate).toMillis() ||
              date.toMillis() > DateTime.fromISO(maxDate).toMillis(),
            disabled: luxonDate.month !== date.month,
          };
        }),
      );
  }, [displayedDate, minDate, maxDate, weekStart]);

  const handleDaySelect = (date: DateTime) => {
    setSelectedDay(padValue(date.day.toString(), "day"));
    setSelectedMonth(padValue(date.month.toString(), "month"));
    setSelectedYear(padValue(date.year.toString(), "year"));
    if (type === "datetime") {
      setCurrentTab("time");
    } else if (type === "date") {
      onClose();
    }
  };

  useEffect(() => {
    if (open) {
      setCurrentTab(type === "datetime" || type === "date" ? "date" : "time");
    }
  }, [open]);

  useEffect(() => {
    if (value) {
      setDisplayedDate(value);
    }
  }, [value]);

  // All 7 day labels indexed by JS weekday (0=Sun..6=Sat)
  const allDays = [t("calendar.dayAbbr.su", "Su"), t("calendar.dayAbbr.mo", "Mo"), t("calendar.dayAbbr.tu", "Tu"), t("calendar.dayAbbr.we", "We"), t("calendar.dayAbbr.th", "Th"), t("calendar.dayAbbr.fr", "Fr"), t("calendar.dayAbbr.sa", "Sa")];
  const weekDays = Array.from({ length: 7 }, (_, i) => allDays[(weekStart + i) % 7]);

  const component = (
    <div className="flex flex-col gap-1">
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
          <TabsContent value="time">
            <TimePicker
              selectedHour={selectedHour}
              setSelectedHour={setSelectedHour}
              selectedMinute={selectedMinute}
              setSelectedMinute={setSelectedMinute}
              value={value}
            />
          </TabsContent>
        </Tabs>
      )}
      {type === "date" && renderDateContent()}
      {type === "time" && (
        <TimePicker
          selectedHour={selectedHour}
          setSelectedHour={setSelectedHour}
          selectedMinute={selectedMinute}
          setSelectedMinute={setSelectedMinute}
          value={value}
        />
      )}
    </div>
  );

  function renderDateContent() {
    return (
      <>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center">
            <button
              type="button"
              className="text-base font-medium cursor-pointer hover:text-foreground/80 ps-[0.5rem]"
              onClick={() => setYearView(!yearView)}
            >
              {formatDatePreferred(getLuxon(displayedDate, timezone).toJSDate(), { month: "long", year: "numeric" })}
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
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
            selectedYear={selectedYear}
            setSelectedYear={setSelectedYear}
            setYearView={setYearView}
            timezone={timezone}
          />
        ) : (
          <div
            ref={datePickerGridRef}
            role="grid"
            className="w-full overflow-y-auto"
          >
            <div className="flex w-full justify-between">
              {weekDays.map((day) => (
                <div
                  key={day}
                  className={cn(
                    "flex-1 flex items-center justify-center p-0.5",
                    isDesktop ? "text-base" : "text-lg",
                  )}
                >
                  {day}
                </div>
              ))}
            </div>
            <div>
              {weeks.map((days, index) => (
                <div key={index} className="flex justify-between">
                  {days.map(({ date, active, disabled, disabledByChoice }) => (
                    <div
                      key={date.day}
                      className="aspect-square h-full flex-1 flex items-center justify-center"
                    >
                      <button
                        type="button"
                        tabIndex={active ? 0 : -1}
                        ref={active ? selectedItemRef : undefined}
                        onClick={() => handleDaySelect(date)}
                        disabled={disabled || disabledByChoice}
                        className={cn(
                          "aspect-square w-full h-full rounded-full text-base cursor-pointer",
                          active &&
                            "bg-primary text-primary-foreground hover:bg-primary/80",
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
                  ))}
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
          {component}
          <div className="flex justify-end mt-2">
            <Button onClick={onClose} variant="secondary" size="sm">
              {t("common.close", "Close")}
            </Button>
          </div>
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
