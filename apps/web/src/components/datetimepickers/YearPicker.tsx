import { cn } from '@/lib/utils';
import { getLuxon, padValue } from './utils';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useRef } from 'react';
import scrollIntoView from 'scroll-into-view-if-needed';

interface YearPickerProps {
  displayedDate: string;
  setDisplayedDate: (date: string) => void;
  selectedYear: string;
  setSelectedYear: (year: string) => void;
  setYearView: (view: boolean) => void;
  timezone: string;
  minDate: string;
  maxDate: string;
}

export const YearPicker = ({
  displayedDate,
  setDisplayedDate,
  selectedYear,
  setSelectedYear,
  setYearView,
  timezone,
  minDate,
  maxDate,
}: YearPickerProps) => {
  const currentYear = new Date().getFullYear();
  const scrollTargetRef = useRef<HTMLButtonElement>(null);

  // Derive the selectable range from the allowed bounds instead of a hardcoded
  // window, so every year the numeric inputs accept is reachable here too.
  const { minYear, maxYear } = useMemo(() => {
    const min = DateTime.fromISO(minDate, { zone: timezone });
    const max = DateTime.fromISO(maxDate, { zone: timezone });
    return {
      minYear: min.isValid ? min.year : 1,
      maxYear: max.isValid ? max.year : 9999,
    };
  }, [minDate, maxDate, timezone]);

  const years = useMemo(
    () => Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i),
    [minYear, maxYear],
  );

  // Scroll the selection (or, failing that, the current year) into view on open.
  const selectedYearNum = parseInt(selectedYear, 10);
  const scrollYear =
    !isNaN(selectedYearNum) && selectedYearNum >= minYear && selectedYearNum <= maxYear
      ? selectedYearNum
      : Math.min(Math.max(currentYear, minYear), maxYear);

  useEffect(() => {
    if (scrollTargetRef.current) {
      scrollIntoView(scrollTargetRef.current, {
        scrollMode: 'if-needed',
        block: 'center',
        inline: 'nearest',
      });
    }
  }, []);

  return (
    <div className="max-h-[280px] w-full overflow-y-auto">
      <div className="grid grid-cols-4 gap-y-2 gap-x-4 w-full">
        {years.map((year) => (
          <button
            type="button"
            key={year}
            ref={year === scrollYear ? scrollTargetRef : undefined}
            aria-current={year === currentYear ? 'date' : undefined}
            aria-pressed={selectedYearNum === year}
            onClick={() => {
              const newDate = getLuxon(displayedDate, timezone).set({ year }).toISO();
              if (newDate) {
                setDisplayedDate(newDate);
              }
              setSelectedYear(padValue(year.toString(), 'year'));
              setYearView(false);
            }}
            className={cn(
              'rounded-md p-1 cursor-pointer transition-colors text-base',
              selectedYearNum === year
                ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                : 'hover:bg-accent'
            )}
          >
            {year}
          </button>
        ))}
      </div>
    </div>
  );
};
