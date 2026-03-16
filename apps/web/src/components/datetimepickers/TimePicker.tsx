import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getResolved12h } from './utils';

interface TimePickerProps {
  selectedHour: string | null;
  setSelectedHour: (hour: string) => void;
  selectedMinute: string | null;
  setSelectedMinute: (minute: string) => void;
  value: string | null;
}

function getLocalizedDayPeriod(isAM: boolean, locale: string): string {
  const date = new Date(2000, 0, 1, isAM ? 9 : 15, 0);
  const parts = new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true }).formatToParts(date);
  return parts.find(p => p.type === 'dayPeriod')?.value ?? (isAM ? 'AM' : 'PM');
}

function format12hLabel(hour24: number, locale: string): string {
  const period = getLocalizedDayPeriod(hour24 < 12, locale);
  const h = hour24 % 12 || 12;
  return `${h} ${period}`;
}

export const TimePicker = ({ selectedHour, setSelectedHour, selectedMinute, setSelectedMinute }: TimePickerProps) => {
  const { i18n } = useTranslation();
  const is12h = useMemo(() => getResolved12h(), []);
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const minutes = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

  return (
    <div className="flex justify-center p-1">
      <div className="flex flex-row items-center justify-center gap-2">
        <ScrollArea className="h-[200px] w-20 rounded-sm border border-border">
          {hours.map((hour) => (
            <button
              type="button"
              key={hour}
              onClick={() => setSelectedHour(hour)}
              className={cn(
                'w-full p-1 text-center cursor-pointer text-base',
                selectedHour === hour
                  ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                  : 'bg-transparent text-foreground hover:bg-accent'
              )}
            >
              {is12h ? format12hLabel(Number(hour), i18n.language) : hour}
            </button>
          ))}
        </ScrollArea>

        <span className="text-2xl font-bold text-foreground">:</span>

        <ScrollArea className="h-[200px] w-20 rounded-sm border border-border">
          {minutes.map((minute) => (
            <button
              type="button"
              key={minute}
              onClick={() => setSelectedMinute(minute)}
              className={cn(
                'w-full p-1 text-center cursor-pointer text-base',
                selectedMinute === minute
                  ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                  : 'bg-transparent text-foreground hover:bg-accent'
              )}
            >
              {minute}
            </button>
          ))}
        </ScrollArea>
      </div>
    </div>
  );
};
