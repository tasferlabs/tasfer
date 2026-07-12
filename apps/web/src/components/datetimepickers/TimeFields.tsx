import { cn } from '@/lib/utils';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getResolved12h, padValue, toNumberOrNull } from './utils';

export type TimeField = 'hour' | 'minute';

function getLocalizedDayPeriod(isAM: boolean, locale: string): string {
  const date = new Date(2000, 0, 1, isAM ? 9 : 15, 0);
  const parts = new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true }).formatToParts(date);
  return parts.find((p) => p.type === 'dayPeriod')?.value ?? (isAM ? 'AM' : 'PM');
}

interface TimeFieldsProps {
  /** 24-hour value, '' or '00'–'23'. */
  selectedHour: string;
  setSelectedHour: (hour: string) => void;
  /** '' or '00'–'59'. */
  selectedMinute: string;
  setSelectedMinute: (minute: string) => void;
  /** Field the attached clock dial is editing; highlights that input. */
  activeField?: TimeField;
  onFieldSelect?: (field: TimeField) => void;
}

/**
 * Hour and minute inputs with an AM/PM toggle. The toggle only renders when
 * the resolved time format is 12-hour; the hour input then accepts 1–12 and
 * the committed value is always the padded 24-hour string.
 */
export const TimeFields = ({
  selectedHour,
  setSelectedHour,
  selectedMinute,
  setSelectedMinute,
  activeField,
  onFieldSelect,
}: TimeFieldsProps) => {
  const { t, i18n } = useTranslation();
  const is12h = useMemo(() => getResolved12h(), []);
  const hourNum = toNumberOrNull(selectedHour);
  const minuteNum = toNumberOrNull(selectedMinute);
  const isPM = (hourNum ?? 0) >= 12;

  // Raw text while a field is being typed in; null renders the committed value.
  const [hourText, setHourText] = useState<string | null>(null);
  const [minuteText, setMinuteText] = useState<string | null>(null);

  const hourDisplay =
    hourNum === null ? '' : is12h ? String(hourNum % 12 || 12).padStart(2, '0') : padValue(String(hourNum), 'hour');
  const minuteDisplay = minuteNum === null ? '' : padValue(String(minuteNum), 'minute');

  const commitHourText = (text: string) => {
    const num = toNumberOrNull(text);
    if (num === null) return;
    if (is12h) {
      if (num < 1 || num > 12) return;
      setSelectedHour(padValue(String((num % 12) + (isPM ? 12 : 0)), 'hour'));
    } else {
      if (num > 23) return;
      setSelectedHour(padValue(String(num), 'hour'));
    }
  };

  const commitMinuteText = (text: string) => {
    const num = toNumberOrNull(text);
    if (num === null || num > 59) return;
    setSelectedMinute(padValue(String(num), 'minute'));
  };

  const setPeriod = (pm: boolean) => {
    if (hourNum === null) {
      setSelectedHour(pm ? '12' : '00');
    } else if (pm !== isPM) {
      setSelectedHour(padValue(String((hourNum + 12) % 24), 'hour'));
    }
  };

  const fieldClass = (active: boolean) =>
    cn(
      'h-11 w-14 rounded-md border text-center text-lg tabular-nums outline-none',
      'transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
      active ? 'border-primary bg-primary/10 text-primary' : 'border-input bg-transparent text-foreground'
    );

  // Times always read hour:minute left-to-right, also in RTL locales.
  return (
    <div className="flex items-center justify-center gap-2" dir="ltr">
      <input
        type="text"
        inputMode="numeric"
        aria-label={t('common.hour', 'Hour')}
        placeholder="--"
        value={hourText ?? hourDisplay}
        className={fieldClass(activeField === 'hour')}
        onFocus={(e) => {
          onFieldSelect?.('hour');
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(-2);
          setHourText(digits);
          commitHourText(digits);
        }}
        onBlur={() => setHourText(null)}
      />
      <span className="text-xl font-semibold text-foreground">:</span>
      <input
        type="text"
        inputMode="numeric"
        aria-label={t('common.minute', 'Minute')}
        placeholder="--"
        value={minuteText ?? minuteDisplay}
        className={fieldClass(activeField === 'minute')}
        onFocus={(e) => {
          onFieldSelect?.('minute');
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(-2);
          setMinuteText(digits);
          commitMinuteText(digits);
        }}
        onBlur={() => setMinuteText(null)}
      />
      {is12h && (
        <div className="ms-3 flex items-center gap-1 text-sm font-medium">
          {[false, true].map((pm) => (
            <button
              key={pm ? 'pm' : 'am'}
              type="button"
              aria-pressed={isPM === pm}
              onClick={() => setPeriod(pm)}
              className={cn(
                'cursor-pointer rounded-md px-1.5 py-1',
                isPM === pm ? 'font-semibold text-primary' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {getLocalizedDayPeriod(!pm, i18n.language)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
