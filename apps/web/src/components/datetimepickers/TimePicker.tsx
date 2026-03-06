import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';

interface TimePickerProps {
  selectedHour: string | null;
  setSelectedHour: (hour: string) => void;
  selectedMinute: string | null;
  setSelectedMinute: (minute: string) => void;
  value: string | null;
}

export const TimePicker = ({ selectedHour, setSelectedHour, selectedMinute, setSelectedMinute }: TimePickerProps) => {
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
              {hour}
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
