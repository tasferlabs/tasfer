import { cn } from '@/lib/utils';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TimeFields, type TimeField } from './TimeFields';
import { getResolved12h, padValue, toNumberOrNull } from './utils';

interface TimePickerProps {
  /** 24-hour value, '00'–'23'. */
  selectedHour: string;
  setSelectedHour: (hour: string) => void;
  /** '00'–'59'. */
  selectedMinute: string;
  setSelectedMinute: (minute: string) => void;
}

// Label radii as a percentage of the dial size (viewBox 0 0 100 100).
const OUTER_RADIUS = 40;
const INNER_RADIUS = 26;

function polar(radius: number, index: number, count: number) {
  const angle = (index / count) * 2 * Math.PI;
  return { x: 50 + radius * Math.sin(angle), y: 50 - radius * Math.cos(angle) };
}

interface DialLabel {
  text: string;
  value: number;
  index: number;
  radius: number;
  muted: boolean;
}

function ClockDial({
  mode,
  is12h,
  hour,
  minute,
  onSelect,
  onInteractionEnd,
  label,
}: {
  mode: TimeField;
  is12h: boolean;
  hour: number;
  minute: number;
  onSelect: (field: TimeField, value: number) => void;
  onInteractionEnd: () => void;
  label: string;
}) {
  const dialRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const labels: DialLabel[] = useMemo(() => {
    if (mode === 'minute') {
      return Array.from({ length: 12 }, (_, i) => ({
        text: String(i * 5).padStart(2, '0'),
        value: i * 5,
        index: i,
        radius: OUTER_RADIUS,
        muted: false,
      }));
    }
    const outer = Array.from({ length: 12 }, (_, i) => ({
      text: String(i === 0 ? 12 : i).padStart(2, '0'),
      value: is12h ? (i % 12) + (hour >= 12 ? 12 : 0) : i === 0 ? 12 : i,
      index: i,
      radius: OUTER_RADIUS,
      muted: false,
    }));
    if (is12h) return outer;
    const inner = Array.from({ length: 12 }, (_, i) => ({
      text: String(i === 0 ? 0 : i + 12).padStart(2, '0'),
      value: i === 0 ? 0 : i + 12,
      index: i,
      radius: INNER_RADIUS,
      muted: true,
    }));
    return [...outer, ...inner];
  }, [mode, is12h, hour]);

  const selected = mode === 'minute' ? minute : hour;
  const handIndex = mode === 'minute' ? minute : hour % 12;
  const handCount = mode === 'minute' ? 60 : 12;
  const handRadius =
    mode === 'hour' && !is12h && (hour === 0 || hour > 12) ? INNER_RADIUS : OUTER_RADIUS;
  const tip = polar(handRadius, handIndex, handCount);
  // Off-label minutes have no highlighted number, so mark the hand tip instead.
  const showTipDot = mode === 'minute' && minute % 5 !== 0;

  const applyPointer = (e: React.PointerEvent) => {
    const el = dialRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const normalized = (angle + 360) % 360;
    if (mode === 'minute') {
      onSelect('minute', Math.round(normalized / 6) % 60);
      return;
    }
    const index = Math.round(normalized / 30) % 12;
    // Fraction of the dial radius; the ring boundary sits between the two label radii.
    const distance = Math.hypot(dx, dy) / (rect.width / 2);
    const inner = !is12h && distance < (OUTER_RADIUS + INNER_RADIUS) / 100;
    let value: number;
    if (is12h) {
      value = (index % 12) + (hour >= 12 ? 12 : 0);
    } else if (inner) {
      value = index === 0 ? 0 : index + 12;
    } else {
      value = index === 0 ? 12 : index;
    }
    onSelect('hour', value);
  };

  return (
    <div
      ref={dialRef}
      role="img"
      aria-label={label}
      className="relative mx-auto size-64 max-w-full cursor-pointer touch-none select-none rounded-full border border-border bg-muted/40"
      onPointerDown={(e) => {
        e.preventDefault();
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        applyPointer(e);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) applyPointer(e);
      }}
      onPointerUp={() => {
        if (draggingRef.current) {
          draggingRef.current = false;
          onInteractionEnd();
        }
      }}
    >
      <svg className="pointer-events-none absolute inset-0 size-full text-primary" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx={50} cy={50} r={1.6} fill="currentColor" />
        <line x1={50} y1={50} x2={tip.x} y2={tip.y} stroke="currentColor" strokeWidth={1.2} />
        {showTipDot && <circle cx={tip.x} cy={tip.y} r={2.2} fill="currentColor" />}
      </svg>
      {labels.map(({ text, value, index, radius, muted }) => {
        const { x, y } = polar(radius, index, 12);
        const active = selected === value;
        return (
          <div
            key={`${radius}-${index}`}
            aria-hidden="true"
            className={cn(
              'absolute flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full tabular-nums',
              muted ? 'text-xs' : 'text-sm',
              active ? 'bg-primary text-primary-foreground' : muted ? 'text-muted-foreground' : 'text-foreground'
            )}
            style={{ left: `${x}%`, top: `${y}%` }}
          >
            {text}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Clock-face time picker: hour/minute fields with an AM/PM toggle (12-hour
 * format only) and an analog dial that edits the focused field. Controlled;
 * the host owns staging and commit (e.g. the overlay's Cancel/Apply).
 */
export const TimePicker = ({ selectedHour, setSelectedHour, selectedMinute, setSelectedMinute }: TimePickerProps) => {
  const { t } = useTranslation();
  const is12h = useMemo(() => getResolved12h(), []);
  const [mode, setMode] = useState<TimeField>('hour');
  const hour = toNumberOrNull(selectedHour) ?? 0;
  const minute = toNumberOrNull(selectedMinute) ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <TimeFields
        selectedHour={selectedHour}
        setSelectedHour={setSelectedHour}
        selectedMinute={selectedMinute}
        setSelectedMinute={setSelectedMinute}
        activeField={mode}
        onFieldSelect={setMode}
      />
      <ClockDial
        mode={mode}
        is12h={is12h}
        hour={hour}
        minute={minute}
        onSelect={(field, value) =>
          field === 'hour'
            ? setSelectedHour(padValue(String(value), 'hour'))
            : setSelectedMinute(padValue(String(value), 'minute'))
        }
        onInteractionEnd={() => {
          if (mode === 'hour') setMode('minute');
        }}
        label={t('timePicker.dial', 'Clock dial')}
      />
    </div>
  );
};
