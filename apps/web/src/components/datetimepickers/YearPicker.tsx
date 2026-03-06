import { cn } from '@/lib/utils';
import { getLuxon, padValue } from './utils';
import { useEffect, useRef } from 'react';
import scrollIntoView from 'scroll-into-view-if-needed';

interface YearPickerProps {
  displayedDate: string;
  setDisplayedDate: (date: string) => void;
  selectedYear: string;
  setSelectedYear: (year: string) => void;
  setYearView: (view: boolean) => void;
  timezone: string;
}

export const YearPicker = ({
  displayedDate,
  setDisplayedDate,
  selectedYear,
  setSelectedYear,
  setYearView,
  timezone,
}: YearPickerProps) => {
  const currentYear = new Date().getFullYear();
  const currentYearRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (currentYearRef.current) {
      scrollIntoView(currentYearRef.current, {
        scrollMode: 'if-needed',
        block: 'center',
        inline: 'nearest',
      });
    }
  }, []);

  return (
    <div className="max-h-[280px] w-full overflow-y-auto">
      <div className="grid grid-cols-4 gap-y-2 gap-x-4 w-full">
        {Array.from({ length: 2100 - 1900 }, (_, i) => 1900 + i).map((year) => (
          <button
            type="button"
            key={year}
            ref={year === currentYear ? currentYearRef : undefined}
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
              parseInt(selectedYear, 10) === year
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
