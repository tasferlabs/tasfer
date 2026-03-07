import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Calendar, X } from 'lucide-react';
import { DateTime } from 'luxon';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { DateTimeInputGroup } from './DateTimeInputGroup';
import { DateTimeRangePickerOverlay } from './DateTimeRangePickerOverlay';
import { getLuxon, toNumberOrNull } from './utils';

type RangeValue = {
  start: string | null;
  end: string | null;
};

type BaseRangeProp = {
  value: RangeValue;
  label?: string;
  fullWidth?: boolean;
  required?: boolean;
  disabled?: boolean;
  onBlur?: () => void;
  helperText?: React.ReactNode;
  error?: boolean;
  className?: string;
  size?: 'small' | 'medium';
  maxDate?: string | null;
  minDate?: string | null;
  timezone: string;
  onChange: (value: RangeValue) => void;
};

type DateRangeProp = BaseRangeProp & {
  type: 'date';
};

type DateTimeRangeProp = BaseRangeProp & {
  type: 'datetime';
};

type TimeRangeProp = BaseRangeProp & {
  type: 'time';
};

export type DateTimeRangePickerProp = DateRangeProp | DateTimeRangeProp | TimeRangeProp;

const DateTimeRangePicker = React.forwardRef(
  (
    {
      value,
      onChange,
      type,
      label,
      fullWidth,
      required,
      disabled,
      onBlur,
      helperText,
      error,
      className,
      size = 'medium',
      maxDate: maxDateProp = '9999-12-31',
      minDate: minDateProp = '0001-01-01',
      timezone,
    }: DateTimeRangePickerProp,
    ref
  ) => {
    const maxDate = maxDateProp || '9999-12-31';
    const minDate = minDateProp || '0001-01-01';

    const computeStartValue = value.start || null;
    const computeEndValue = value.end || null;

    const id = useId();
    const startInputRef = useRef<HTMLInputElement>(null);
    const endInputRef = useRef<HTMLInputElement>(null);
    const [rangePickerOpen, setRangePickerOpen] = useState(false);

    const parseValues = useCallback(
      (computeValue: string | null, timezone: string | null) => {
        if (!computeValue || !timezone)
          return {
            parsedYear: '',
            parsedMonth: '',
            parsedDay: '',
            parsedHour: '',
            parsedMinute: '',
          };
        const luxonValue = getLuxon(computeValue, timezone);

        return {
          parsedYear: toNumberOrNull(luxonValue.year.toString())?.toString().padStart(4, '0') || '',
          parsedMonth: toNumberOrNull(luxonValue.month.toString())?.toString().padStart(2, '0') || '',
          parsedDay: toNumberOrNull(luxonValue.day.toString())?.toString().padStart(2, '0') || '',
          parsedHour: toNumberOrNull(luxonValue.hour.toString())?.toString().padStart(2, '0') || '',
          parsedMinute: toNumberOrNull(luxonValue.minute.toString())?.toString().padStart(2, '0') || '',
        };
      },
      []
    );

    // Start date state
    const { parsedYear: startParsedYear, parsedMonth: startParsedMonth, parsedDay: startParsedDay, parsedHour: startParsedHour, parsedMinute: startParsedMinute } = useMemo(
      () => parseValues(computeStartValue, timezone),
      [computeStartValue, timezone, parseValues]
    );
    const [startSelectedYear, setStartSelectedYear] = useState(() => startParsedYear);
    const [startSelectedMonth, setStartSelectedMonth] = useState(() => startParsedMonth);
    const [startSelectedDay, setStartSelectedDay] = useState(() => startParsedDay);
    const [startSelectedHour, setStartSelectedHour] = useState(() => startParsedHour);
    const [startSelectedMinute, setStartSelectedMinute] = useState(() => startParsedMinute);

    // End date state
    const { parsedYear: endParsedYear, parsedMonth: endParsedMonth, parsedDay: endParsedDay, parsedHour: endParsedHour, parsedMinute: endParsedMinute } = useMemo(
      () => parseValues(computeEndValue, timezone),
      [computeEndValue, timezone, parseValues]
    );
    const [endSelectedYear, setEndSelectedYear] = useState(() => endParsedYear);
    const [endSelectedMonth, setEndSelectedMonth] = useState(() => endParsedMonth);
    const [endSelectedDay, setEndSelectedDay] = useState(() => endParsedDay);
    const [endSelectedHour, setEndSelectedHour] = useState(() => endParsedHour);
    const [endSelectedMinute, setEndSelectedMinute] = useState(() => endParsedMinute);

    const stillEditableRef = useRef(true);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
      const cancel = setTimeout(() => {
        stillEditableRef.current = false;
        setIsLoading(false);
      }, 500);
      return () => clearTimeout(cancel);
    }, []);

    useEffect(() => {
      if (!stillEditableRef.current) return;
      setStartSelectedYear(startParsedYear);
      setStartSelectedMonth(startParsedMonth);
      setStartSelectedDay(startParsedDay);
      setStartSelectedHour(startParsedHour);
      setStartSelectedMinute(startParsedMinute);
    }, [startParsedYear, startParsedMonth, startParsedDay, startParsedHour, startParsedMinute]);

    useEffect(() => {
      if (!stillEditableRef.current) return;
      setEndSelectedYear(endParsedYear);
      setEndSelectedMonth(endParsedMonth);
      setEndSelectedDay(endParsedDay);
      setEndSelectedHour(endParsedHour);
      setEndSelectedMinute(endParsedMinute);
    }, [endParsedYear, endParsedMonth, endParsedDay, endParsedHour, endParsedMinute]);

    const handleChange = useCallback(
      (newStart: string | null, newEnd: string | null) => {
        onChange({ start: newStart, end: newEnd });
      },
      [onChange]
    );

    // Build ISO string from selected values
    const buildISOString = useCallback(
      (year: string, month: string, day: string, hour: string, minute: string, tz: string) => {
        const yearNum = toNumberOrNull(year);
        const monthNum = toNumberOrNull(month);
        const dayNum = toNumberOrNull(day);
        const hourNum = toNumberOrNull(hour);
        const minuteNum = toNumberOrNull(minute);

        if (type === 'date' && yearNum !== null && monthNum !== null && dayNum !== null) {
          return DateTime.fromObject({ year: yearNum, month: monthNum, day: dayNum }, { zone: tz }).toISODate();
        } else if (type === 'datetime' && yearNum !== null && monthNum !== null && dayNum !== null) {
          return DateTime.fromObject(
            { year: yearNum, month: monthNum, day: dayNum, hour: hourNum ?? undefined, minute: minuteNum ?? undefined },
            { zone: tz }
          ).toISO();
        } else if (type === 'time' && hourNum !== null && minuteNum !== null) {
          return DateTime.fromObject({ hour: hourNum, minute: minuteNum }, { zone: tz }).toISOTime({ includeOffset: true });
        }
        return null;
      },
      [type]
    );

    // Effect for start date changes
    useEffect(() => {
      if (stillEditableRef.current) return;
      const newStart = buildISOString(startSelectedYear, startSelectedMonth, startSelectedDay, startSelectedHour, startSelectedMinute, timezone);
      if (newStart !== computeStartValue) {
        handleChange(newStart, computeEndValue);
      }
    }, [startSelectedYear, startSelectedMonth, startSelectedDay, startSelectedHour, startSelectedMinute, timezone]);

    // Effect for end date changes
    useEffect(() => {
      if (stillEditableRef.current) return;
      const newEnd = buildISOString(endSelectedYear, endSelectedMonth, endSelectedDay, endSelectedHour, endSelectedMinute, timezone);
      if (newEnd !== computeEndValue) {
        handleChange(computeStartValue, newEnd);
      }
    }, [endSelectedYear, endSelectedMonth, endSelectedDay, endSelectedHour, endSelectedMinute, timezone]);

    const incrementStartValue = useCallback(
      (granularity: keyof DateTime<boolean>, delta: number) => {
        const luxonValue = computeStartValue
          ? getLuxon(computeStartValue, timezone).plus({ [granularity]: delta })
          : DateTime.now().setZone(timezone).startOf('day');

        const newStart = type === 'date' ? luxonValue.toISODate() : type === 'datetime' ? luxonValue.toISO() : luxonValue.toISOTime({ includeOffset: true });
        handleChange(newStart, computeEndValue);

        const parsed = parseValues(newStart, timezone);
        setStartSelectedYear(parsed.parsedYear);
        setStartSelectedMonth(parsed.parsedMonth);
        setStartSelectedDay(parsed.parsedDay);
        setStartSelectedHour(parsed.parsedHour);
        setStartSelectedMinute(parsed.parsedMinute);
      },
      [computeStartValue, computeEndValue, timezone, type, handleChange, parseValues]
    );

    const incrementEndValue = useCallback(
      (granularity: keyof DateTime<boolean>, delta: number) => {
        const luxonValue = computeEndValue
          ? getLuxon(computeEndValue, timezone).plus({ [granularity]: delta })
          : DateTime.now().setZone(timezone).startOf('day');

        const newEnd = type === 'date' ? luxonValue.toISODate() : type === 'datetime' ? luxonValue.toISO() : luxonValue.toISOTime({ includeOffset: true });
        handleChange(computeStartValue, newEnd);

        const parsed = parseValues(newEnd, timezone);
        setEndSelectedYear(parsed.parsedYear);
        setEndSelectedMonth(parsed.parsedMonth);
        setEndSelectedDay(parsed.parsedDay);
        setEndSelectedHour(parsed.parsedHour);
        setEndSelectedMinute(parsed.parsedMinute);
      },
      [computeStartValue, computeEndValue, timezone, type, handleChange, parseValues]
    );

    const clearAll = () => {
      handleChange(null, null);
      setStartSelectedYear('');
      setStartSelectedMonth('');
      setStartSelectedDay('');
      setStartSelectedHour('');
      setStartSelectedMinute('');
      setEndSelectedYear('');
      setEndSelectedMonth('');
      setEndSelectedDay('');
      setEndSelectedHour('');
      setEndSelectedMinute('');
    };

    if (isLoading)
      return <Skeleton className={cn('w-full max-w-[300px]', size === 'small' ? 'h-10' : 'h-14')} />;

    return (
      <div className={cn(fullWidth ? 'w-full' : 'w-fit', className)} ref={ref as React.Ref<HTMLDivElement>}>
        <div
          className={cn(
            'flex items-center gap-2 border rounded-md px-3 cursor-text relative',
            error ? 'border-destructive' : 'border-border',
            'hover:border-foreground/50',
            size === 'small' ? 'py-1.5' : 'py-3'
          )}
          onClick={() => startInputRef.current?.focus()}
        >
          {label && (
            <label
              htmlFor={id}
              className={cn(
                'absolute top-0 left-2 z-10 -translate-y-1/2 bg-background px-1 rounded',
                'text-muted-foreground font-medium',
                size === 'small' ? 'text-xs' : 'text-sm'
              )}
            >
              {label}
            </label>
          )}

          <div className="flex flex-row items-center gap-2 flex-wrap">
            {/* Start date inputs */}
            <div
              onClick={(ev) => {
                ev.stopPropagation();
                setRangePickerOpen(true);
              }}
              className="cursor-pointer"
            >
              <DateTimeInputGroup
                selectedYear={startSelectedYear}
                selectedMonth={startSelectedMonth}
                selectedDay={startSelectedDay}
                selectedHour={startSelectedHour}
                selectedMinute={startSelectedMinute}
                setSelectedYear={setStartSelectedYear}
                setSelectedMonth={setStartSelectedMonth}
                setSelectedDay={setStartSelectedDay}
                setSelectedHour={setStartSelectedHour}
                setSelectedMinute={setStartSelectedMinute}
                incrementValue={incrementStartValue}
                ref={startInputRef}
                required={required}
                disabled={disabled}
                onBlur={onBlur}
                type={type}
                size={size}
              />
            </div>

            <span className={cn('text-muted-foreground mx-0.5', size === 'small' ? 'text-xs' : 'text-sm')}>–</span>

            {/* End date inputs */}
            <div
              onClick={(ev) => {
                ev.stopPropagation();
                setRangePickerOpen(true);
              }}
              className="cursor-pointer"
            >
              <DateTimeInputGroup
                selectedYear={endSelectedYear}
                selectedMonth={endSelectedMonth}
                selectedDay={endSelectedDay}
                selectedHour={endSelectedHour}
                selectedMinute={endSelectedMinute}
                setSelectedYear={setEndSelectedYear}
                setSelectedMonth={setEndSelectedMonth}
                setSelectedDay={setEndSelectedDay}
                setSelectedHour={setEndSelectedHour}
                setSelectedMinute={setEndSelectedMinute}
                incrementValue={incrementEndValue}
                ref={endInputRef}
                required={required}
                disabled={disabled}
                onBlur={onBlur}
                type={type}
                size={size}
              />
            </div>
          </div>

          <div className="flex items-center ml-auto">
            <Button type="button" variant="ghost" size={size === 'small' ? 'icon-xs' : 'icon-sm'} disabled={disabled} onClick={clearAll}>
              <X className={size === 'small' ? 'size-4' : 'size-5'} />
            </Button>

            <Button
              type="button"
              variant="ghost"
              size={size === 'small' ? 'icon-xs' : 'icon-sm'}
              disabled={disabled}
              onClick={(ev) => {
                ev.stopPropagation();
                setRangePickerOpen(true);
              }}
            >
              <Calendar className={size === 'small' ? 'size-4' : 'size-5'} />
            </Button>
          </div>
        </div>

        {/* Range picker overlay */}
        <DateTimeRangePickerOverlay
          open={rangePickerOpen}
          onClose={() => setRangePickerOpen(false)}
          startSelectedYear={startSelectedYear}
          startSelectedMonth={startSelectedMonth}
          startSelectedDay={startSelectedDay}
          setStartSelectedYear={setStartSelectedYear}
          setStartSelectedMonth={setStartSelectedMonth}
          setStartSelectedDay={setStartSelectedDay}
          startSelectedHour={startSelectedHour}
          startSelectedMinute={startSelectedMinute}
          setStartSelectedHour={setStartSelectedHour}
          setStartSelectedMinute={setStartSelectedMinute}
          startValue={computeStartValue}
          endSelectedYear={endSelectedYear}
          endSelectedMonth={endSelectedMonth}
          endSelectedDay={endSelectedDay}
          setEndSelectedYear={setEndSelectedYear}
          setEndSelectedMonth={setEndSelectedMonth}
          setEndSelectedDay={setEndSelectedDay}
          endSelectedHour={endSelectedHour}
          endSelectedMinute={endSelectedMinute}
          setEndSelectedHour={setEndSelectedHour}
          setEndSelectedMinute={setEndSelectedMinute}
          endValue={computeEndValue}
          id={id}
          timezone={timezone}
          type={type}
          maxDate={maxDate}
          minDate={minDate}
        />

        {React.isValidElement(helperText) ? (
          helperText
        ) : typeof helperText === 'string' && !!helperText ? (
          <p className={cn('mt-1 text-sm text-left', error ? 'text-destructive' : 'text-muted-foreground')}>
            {helperText}
          </p>
        ) : null}
      </div>
    );
  }
);

export default React.memo(DateTimeRangePicker);
