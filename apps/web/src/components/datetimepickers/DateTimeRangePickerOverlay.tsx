import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLuxon, padValue, plusDatetime } from './utils';
import { TimeFields } from './TimeFields';
import { getWeekStart, formatDatePreferred } from '@/lib/dateTimePreferences';

type RangePickerOverlayProps = {
  open: boolean;
  onClose: () => void;
  startSelectedYear: string;
  startSelectedMonth: string;
  startSelectedDay: string;
  setStartSelectedYear: (year: string) => void;
  setStartSelectedMonth: (month: string) => void;
  setStartSelectedDay: (day: string) => void;
  startSelectedHour: string;
  startSelectedMinute: string;
  setStartSelectedHour: (hour: string) => void;
  setStartSelectedMinute: (minute: string) => void;
  startValue: string | null;
  endSelectedYear: string;
  endSelectedMonth: string;
  endSelectedDay: string;
  setEndSelectedYear: (year: string) => void;
  setEndSelectedMonth: (month: string) => void;
  setEndSelectedDay: (day: string) => void;
  endSelectedHour: string;
  endSelectedMinute: string;
  setEndSelectedHour: (hour: string) => void;
  setEndSelectedMinute: (minute: string) => void;
  endValue: string | null;
  id: string;
  timezone: string;
  type: 'date' | 'datetime' | 'time';
  maxDate: string;
  minDate: string;
};

export function DateTimeRangePickerOverlay({
  open,
  onClose,
  startSelectedYear: _startSelectedYear,
  startSelectedMonth: _startSelectedMonth,
  startSelectedDay: _startSelectedDay,
  setStartSelectedYear,
  setStartSelectedMonth,
  setStartSelectedDay,
  startSelectedHour,
  startSelectedMinute,
  setStartSelectedHour,
  setStartSelectedMinute,
  startValue,
  endSelectedYear: _endSelectedYear,
  endSelectedMonth: _endSelectedMonth,
  endSelectedDay: _endSelectedDay,
  setEndSelectedYear,
  setEndSelectedMonth,
  setEndSelectedDay,
  endSelectedHour,
  endSelectedMinute,
  setEndSelectedHour,
  setEndSelectedMinute,
  endValue,
  id: _id,
  timezone,
  type,
  maxDate,
  minDate,
}: RangePickerOverlayProps) {
  const { t } = useTranslation();
  const isDesktop = typeof window !== 'undefined' && window.matchMedia('(min-width: 700px)').matches;

  const [activeRange, setActiveRange] = useState<'start' | 'end'>('start');
  const [currentTab, setCurrentTab] = useState<'date' | 'time'>(
    type === 'datetime' || type === 'date' ? 'date' : 'time'
  );
  const [hoveredDate, setHoveredDate] = useState<DateTime | null>(null);

  const [displayedDate, setDisplayedDate] = useState(() => {
    if (startValue) return startValue;
    return DateTime.now().setZone(timezone).toISO() || '';
  });

  const leftDisplayedDate = displayedDate;
  const rightDisplayedDate = useMemo(
    () => plusDatetime(displayedDate, 'month', 1, timezone) || displayedDate,
    [displayedDate, timezone]
  );

  useEffect(() => {
    if (open) {
      setCurrentTab(type === 'datetime' || type === 'date' ? 'date' : 'time');
      setActiveRange('start');
    }
  }, [open, type]);

  useEffect(() => {
    if (startValue) setDisplayedDate(startValue);
  }, [startValue]);

  const startDateTime = useMemo(() => {
    if (!startValue) return null;
    return getLuxon(startValue, timezone);
  }, [startValue, timezone]);

  const endDateTime = useMemo(() => {
    if (!endValue) return null;
    return getLuxon(endValue, timezone);
  }, [endValue, timezone]);

  type WeekDay = {
    date: DateTime;
    isStart: boolean | null;
    isEnd: boolean | null;
    isInRange: boolean | "" | null;
    isInPreviewRange: boolean;
    isPreviewEnd: boolean;
    startIsVisible: boolean;
    endIsVisible: boolean;
    disabledByChoice: boolean;
    disabled: boolean;
  };
  const weekStart = getWeekStart();

  const generateWeeks = (displayedDate: string, tz: string, allWeeksInView: DateTime[]): WeekDay[][] => {
    const luxonDate = getLuxon(displayedDate, tz);
    const firstOfMonth = luxonDate.startOf('month');
    const jsWeekday = firstOfMonth.weekday % 7; // luxon 1=Mon..7=Sun → 0=Sun..6=Sat
    const offset = (jsWeekday - weekStart + 7) % 7;
    const gridStart = firstOfMonth.minus({ days: offset });
    return Array(6)
      .fill(Array(7).fill(0))
      .map((week, i) =>
        week.map((_: number, j: number) => {
          const date = gridStart.plus({ days: 7 * i + j });

          const isStart = startDateTime && date.toISODate() === startDateTime.toISODate();
          const isEnd = endDateTime && date.toISODate() === endDateTime.toISODate();

          const startIsVisible = startDateTime && allWeeksInView.some(d => d.toISODate() === startDateTime.toISODate());
          const endIsVisible = endDateTime && allWeeksInView.some(d => d.toISODate() === endDateTime.toISODate());

          const isInRange =
            startDateTime &&
            endDateTime &&
            startIsVisible &&
            endIsVisible &&
            date.toMillis() > startDateTime.startOf('day').toMillis() &&
            date.toMillis() < endDateTime.startOf('day').toMillis();

          let isInPreviewRange = false;
          let isPreviewEnd = false;
          if (hoveredDate && !date.equals(hoveredDate)) {
            if (activeRange === 'end' && startDateTime) {
              const previewEnd = hoveredDate.toMillis() < startDateTime.toMillis() ? startDateTime : hoveredDate;
              const actualStart = hoveredDate.toMillis() < startDateTime.toMillis() ? hoveredDate : startDateTime;

              isInPreviewRange =
                date.toMillis() > actualStart.startOf('day').toMillis() &&
                date.toMillis() < previewEnd.startOf('day').toMillis();
            }
          }

          if (hoveredDate && date.toISODate() === hoveredDate.toISODate()) {
            isPreviewEnd = true;
          }

          return {
            date,
            isStart,
            isEnd,
            isInRange,
            isInPreviewRange,
            isPreviewEnd,
            startIsVisible: !!startIsVisible,
            endIsVisible: !!endIsVisible,
            disabledByChoice:
              date.toMillis() < DateTime.fromISO(minDate).toMillis() ||
              date.toMillis() > DateTime.fromISO(maxDate).toMillis(),
            disabled: luxonDate.month !== date.month,
          };
        })
      );
  };

  const allDatesInView = useMemo(() => {
    const dates: DateTime[] = [];
    const leftLuxon = getLuxon(leftDisplayedDate, timezone);
    const rightLuxon = getLuxon(rightDisplayedDate, timezone);

    const leftFirst = leftLuxon.startOf('month');
    const leftJsWd = leftFirst.weekday % 7;
    const leftOffset = (leftJsWd - weekStart + 7) % 7;
    const leftGridStart = leftFirst.minus({ days: leftOffset });

    const rightFirst = rightLuxon.startOf('month');
    const rightJsWd = rightFirst.weekday % 7;
    const rightOffset = (rightJsWd - weekStart + 7) % 7;
    const rightGridStart = rightFirst.minus({ days: rightOffset });

    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 7; j++) {
        const leftDate = leftGridStart.plus({ days: 7 * i + j });
        const rightDate = rightGridStart.plus({ days: 7 * i + j });
        if (leftLuxon.month === leftDate.month) dates.push(leftDate);
        if (rightLuxon.month === rightDate.month) dates.push(rightDate);
      }
    }
    return dates;
  }, [leftDisplayedDate, rightDisplayedDate, timezone, weekStart]);

  const leftWeeks = useMemo(
    () => generateWeeks(leftDisplayedDate, timezone, allDatesInView),
    [leftDisplayedDate, timezone, startDateTime, endDateTime, minDate, maxDate, hoveredDate, activeRange, allDatesInView]
  );

  const rightWeeks = useMemo(
    () => generateWeeks(rightDisplayedDate, timezone, allDatesInView),
    [rightDisplayedDate, timezone, startDateTime, endDateTime, minDate, maxDate, hoveredDate, activeRange, allDatesInView]
  );

  const handleDaySelect = (date: DateTime) => {
    if (activeRange === 'start') {
      setStartSelectedDay(padValue(date.day.toString(), 'day'));
      setStartSelectedMonth(padValue(date.month.toString(), 'month'));
      setStartSelectedYear(padValue(date.year.toString(), 'year'));
      setActiveRange('end');
    } else {
      if (startDateTime && date.toMillis() < startDateTime.toMillis()) {
        setStartSelectedDay(padValue(date.day.toString(), 'day'));
        setStartSelectedMonth(padValue(date.month.toString(), 'month'));
        setStartSelectedYear(padValue(date.year.toString(), 'year'));
        setEndSelectedDay(padValue(startDateTime.day.toString(), 'day'));
        setEndSelectedMonth(padValue(startDateTime.month.toString(), 'month'));
        setEndSelectedYear(padValue(startDateTime.year.toString(), 'year'));
      } else {
        setEndSelectedDay(padValue(date.day.toString(), 'day'));
        setEndSelectedMonth(padValue(date.month.toString(), 'month'));
        setEndSelectedYear(padValue(date.year.toString(), 'year'));
      }

      if (type === 'datetime') {
        setCurrentTab('time');
      } else if (type === 'date') {
        onClose();
      }
    }
  };

  const allDays = [t("calendar.dayAbbr.su", "Su"), t("calendar.dayAbbr.mo", "Mo"), t("calendar.dayAbbr.tu", "Tu"), t("calendar.dayAbbr.we", "We"), t("calendar.dayAbbr.th", "Th"), t("calendar.dayAbbr.fr", "Fr"), t("calendar.dayAbbr.sa", "Sa")];
  const weekDays = Array.from({ length: 7 }, (_, i) => allDays[(weekStart + i) % 7]);

  const renderCalendarGrid = (weeks: ReturnType<typeof generateWeeks>) => (
    <div role="grid" className="w-full" onMouseLeave={() => setHoveredDate(null)}>
      <div className="flex w-full justify-between px-0.5">
        {weekDays.map((day) => (
          <div key={day} className="flex-1 flex items-center justify-center p-0.5 text-sm">
            {day}
          </div>
        ))}
      </div>
      <div>
        {weeks.map((days, index) => (
          <div key={index} className="flex justify-between px-0.5">
            {days.map(({ date, isStart, isEnd, isInRange, isInPreviewRange, isPreviewEnd, disabled, disabledByChoice }) => (
              <div
                key={date.toISODate()}
                className={cn(
                  'aspect-square h-full flex-1 flex items-center justify-center relative',
                  !disabled && isInPreviewRange && !isInRange && 'bg-primary/5',
                  !disabled && isInRange && 'bg-primary/10',
                  !disabled && isStart && 'rounded-s-full',
                  !disabled && isStart && (endDateTime || isInPreviewRange || isPreviewEnd) && 'bg-primary/10',
                  !disabled && isEnd && 'rounded-e-full',
                  !disabled && isEnd && startDateTime && 'bg-primary/10',
                  !disabled && isPreviewEnd && !isEnd && !isStart && activeRange === 'end' && startDateTime && 'rounded-e-full bg-primary/5',
                )}
              >
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => handleDaySelect(date)}
                    onMouseEnter={() => !disabledByChoice && setHoveredDate(date)}
                    disabled={disabledByChoice}
                    className={cn(
                      'aspect-square w-full h-full rounded-full text-sm cursor-pointer',
                      (isStart || isEnd) && 'bg-primary text-primary-foreground hover:bg-primary/80',
                      isPreviewEnd && !isStart && !isEnd && !disabledByChoice && 'bg-primary/30 hover:bg-primary/40',
                      disabledByChoice && 'text-muted-foreground opacity-50 cursor-not-allowed',
                      !isStart && !isEnd && !isPreviewEnd && !disabledByChoice && 'hover:bg-accent'
                    )}
                  >
                    {date.day}
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );

  const navigationHeader = (
    <div className="flex items-center justify-between mb-2">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setDisplayedDate((d) => plusDatetime(d, 'month', -1, timezone)!)}
      >
        <ChevronLeft className="size-4 rtl:rotate-180" />
      </Button>

      <div className="flex items-center gap-1">
        <span className="text-base font-medium text-center min-w-[120px]">
          {formatDatePreferred(getLuxon(leftDisplayedDate, timezone).toJSDate(), { month: 'short', year: 'numeric' })}
        </span>
        {isDesktop && (
          <>
            <span className="text-sm text-muted-foreground">–</span>
            <span className="text-base font-medium text-center min-w-[120px]">
              {formatDatePreferred(getLuxon(rightDisplayedDate, timezone).toJSDate(), { month: 'short', year: 'numeric' })}
            </span>
          </>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setDisplayedDate((d) => plusDatetime(d, 'month', 1, timezone)!)}
      >
        <ChevronRight className="size-4 rtl:rotate-180" />
      </Button>
    </div>
  );

  const dateContent = (
    <>
      {navigationHeader}
      {isDesktop ? (
        <div className="flex gap-3">
          <div className="flex-1 min-w-[280px]">
            {renderCalendarGrid(leftWeeks)}
          </div>
          <div className="flex-1 min-w-[280px]">
            {renderCalendarGrid(rightWeeks)}
          </div>
        </div>
      ) : (
        renderCalendarGrid(leftWeeks)
      )}
    </>
  );

  const timeContent = (
    <div className={cn('flex gap-3', isDesktop ? 'flex-row' : 'flex-col')}>
      <div className="flex-1">
        <span className="text-xs text-muted-foreground mb-1 block">{t("calendar.startTime", "Start time")}</span>
        <TimeFields
          selectedHour={startSelectedHour}
          setSelectedHour={setStartSelectedHour}
          selectedMinute={startSelectedMinute}
          setSelectedMinute={setStartSelectedMinute}
        />
      </div>
      <div className="flex-1">
        <span className="text-xs text-muted-foreground mb-1 block">{t("calendar.endTime", "End time")}</span>
        <TimeFields
          selectedHour={endSelectedHour}
          setSelectedHour={setEndSelectedHour}
          selectedMinute={endSelectedMinute}
          setSelectedMinute={setEndSelectedMinute}
        />
      </div>
    </div>
  );

  const component = (
    <div>
      {type === 'datetime' && (
        <Tabs value={currentTab} onValueChange={(v) => setCurrentTab(v as 'date' | 'time')}>
          <TabsList className="w-full mb-2">
            <TabsTrigger value="date" className="flex-1">{t("common.date", "Date")}</TabsTrigger>
            <TabsTrigger value="time" className="flex-1">{t("common.time", "Time")}</TabsTrigger>
          </TabsList>
          <TabsContent value="date">{dateContent}</TabsContent>
          <TabsContent value="time">{timeContent}</TabsContent>
        </Tabs>
      )}
      {type === 'date' && dateContent}
      {type === 'time' && timeContent}
    </div>
  );

  if (!isDesktop) {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-[400px] p-4 pt-6 max-h-[90vh] overflow-y-auto">
          <DialogTitle className="sr-only">{t("common.date", "Date")}</DialogTitle>
          {component}
          <div className="flex justify-end mt-2">
            <Button onClick={onClose} variant="secondary" size="sm">
              {t("common.done", "Done")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open={open} onOpenChange={(v) => !v && onClose()}>
      <PopoverAnchor />
      <PopoverContent className="w-auto p-3" align="center">
        {component}
        <div className="flex justify-end mt-2">
          <Button onClick={onClose} variant="secondary" size="sm">
            {t("common.done", "Done")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
