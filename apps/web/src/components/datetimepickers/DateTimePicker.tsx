import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Calendar, X } from 'lucide-react';
import { DateTime } from 'luxon';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { DateTimeInputGroup } from './DateTimeInputGroup';
import { DateTimePickerOverlay } from './DateTimePickerOverlay';
import { getLuxon, toNumberOrNull } from './utils';

type BaseProp = {
  value: string | null;
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
  onChange: (value: string | null) => void;
};

type DateProp = BaseProp & {
  type: 'date';
};

type DateTimeProp = BaseProp & {
  type: 'datetime';
};

type TimeProp = BaseProp & {
  type: 'time';
};

export type DateTimePickerProp = DateProp | DateTimeProp | TimeProp;

const EgDateTimePicker = React.forwardRef(
  (
    {
      value,
      onChange,
      type,
      label,
      fullWidth = false,
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
    }: DateTimePickerProp,
    ref
  ) => {
    const maxDate = maxDateProp || '9999-12-31';
    const minDate = minDateProp || '0001-01-01';
    const computeValue = value || null;

    function exceedsMaxDate(value: string | null, maxDate: string) {
      if (!value) return false;
      const date = DateTime.fromISO(value);
      return date.toMillis() > DateTime.fromISO(maxDate).toMillis();
    }
    function exceedsMinDate(value: string | null, minDate: string) {
      if (!value) return false;
      const date = DateTime.fromISO(value);
      return date.toMillis() < DateTime.fromISO(minDate).toMillis();
    }
    function handleChange(argValue: string | null, override = false) {
      if (computeValue !== argValue) {
        let newArgValue = argValue;
        if (override) {
          if (exceedsMaxDate(argValue, maxDate)) {
            newArgValue = maxDate;
          }
          if (exceedsMinDate(argValue, minDate)) {
            newArgValue = minDate;
          }
        }
        onChange(newArgValue);
        if (!override) {
          return;
        }

        const { parsedYear, parsedMonth, parsedDay, parsedHour, parsedMinute } = parseValues(newArgValue, timezone);
        setSelectedYear(parsedYear);
        setSelectedMonth(parsedMonth);
        setSelectedDay(parsedDay);
        setSelectedHour(parsedHour);
        setSelectedMinute(parsedMinute);
      }
    }

    const id = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const [datePickerOpen, setDatePickerOpen] = useState(false);

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
      [computeValue, timezone]
    );

    const { parsedYear, parsedMonth, parsedDay, parsedHour, parsedMinute } = useMemo(
      () => parseValues(computeValue, timezone),
      [computeValue, timezone, parseValues]
    );
    const [selectedYear, setSelectedYear] = useState(() => parsedYear);
    const [selectedMonth, setSelectedMonth] = useState(() => parsedMonth);
    const [selectedDay, setSelectedDay] = useState(() => parsedDay);
    const [selectedHour, setSelectedHour] = useState(() => parsedHour);
    const [selectedMinute, setSelectedMinute] = useState(() => parsedMinute);

    const isSyncingFromProps = useRef(false);
    const handleChangeRef = useRef(handleChange) as MutableRefObject<typeof handleChange>;
    handleChangeRef.current = handleChange;
    const latestValueRef = useRef(computeValue);
    useEffect(() => {
      latestValueRef.current = computeValue;
    }, [computeValue]);

    useEffect(() => {
      isSyncingFromProps.current = true;
      setSelectedYear(parsedYear);
      setSelectedMonth(parsedMonth);
      setSelectedDay(parsedDay);
      setSelectedHour(parsedHour);
      setSelectedMinute(parsedMinute);
    }, [parsedYear, parsedMonth, parsedDay, parsedHour, parsedMinute]);

    useEffect(() => {
      if (isSyncingFromProps.current) {
        isSyncingFromProps.current = false;
        return;
      }
      const yearNum = toNumberOrNull(selectedYear);
      const monthNum = toNumberOrNull(selectedMonth);
      const dayNum = toNumberOrNull(selectedDay);
      const hourNum = toNumberOrNull(selectedHour);
      const minuteNum = toNumberOrNull(selectedMinute);
      if (type === 'date' && yearNum !== null && monthNum !== null && dayNum !== null) {
        handleChangeRef.current(
          DateTime.fromObject(
            { year: yearNum, month: monthNum, day: dayNum },
            { zone: timezone }
          ).toISODate()
        );
      } else if (type === 'datetime' && yearNum !== null && monthNum !== null && dayNum !== null) {
        handleChangeRef.current(
          DateTime.fromObject(
            { year: yearNum, month: monthNum, day: dayNum, hour: hourNum ?? undefined, minute: minuteNum ?? undefined },
            { zone: timezone }
          ).toISO()
        );
      } else if (type === 'time' && hourNum !== null && minuteNum !== null) {
        handleChangeRef.current(
          DateTime.fromObject({ hour: hourNum, minute: minuteNum }, { zone: timezone }).toISOTime({
            includeOffset: true,
          })
        );
      } else if (
        (type === 'date' && yearNum === null && monthNum === null && dayNum === null) ||
        (type === 'time' && hourNum === null && minuteNum === null) ||
        (type === 'datetime' &&
          ((yearNum === null && monthNum === null && dayNum === null) || (hourNum === null && minuteNum === null)))
      ) {
        handleChangeRef.current(null);
      }
    }, [selectedYear, selectedMonth, selectedDay, selectedHour, selectedMinute, timezone, type]);

    const incrementValue = useCallback(
      (granularity: keyof DateTime<boolean>, value: number) => {
        const currentValue = latestValueRef.current;
        const luxonValue = currentValue
          ? getLuxon(currentValue, timezone).plus({ [granularity]: value })
          : DateTime.now().setZone(timezone).startOf('day');

        let newValue: string | null;
        if (type === 'date') {
          newValue = luxonValue.toISODate();
        } else if (type === 'datetime') {
          newValue = luxonValue.toISO();
        } else {
          newValue = luxonValue.toISOTime({ includeOffset: true });
        }

        // Update ref synchronously so rapid key presses see the latest value
        latestValueRef.current = newValue;
        handleChangeRef.current(newValue, true);
      },
      [timezone, type]
    );

    return (
      <div className={cn(fullWidth ? 'w-full' : 'w-fit', className)} ref={ref as React.Ref<HTMLDivElement>}>
        <div
          className={cn(
            'flex items-center gap-2 rounded-md border border-input dark:bg-input/30 bg-transparent px-2.5 shadow-xs cursor-text relative',
            'transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
            error && 'border-destructive aria-invalid:ring-destructive/20',
            size === 'small' ? 'h-9' : 'h-10'
          )}
          onClick={() => inputRef.current?.focus()}
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
          <div className="flex items-center gap-2">
            <DateTimeInputGroup
              selectedYear={selectedYear}
              selectedMonth={selectedMonth}
              selectedDay={selectedDay}
              selectedHour={selectedHour}
              selectedMinute={selectedMinute}
              setSelectedYear={setSelectedYear}
              setSelectedMonth={setSelectedMonth}
              setSelectedDay={setSelectedDay}
              setSelectedHour={setSelectedHour}
              setSelectedMinute={setSelectedMinute}
              incrementValue={incrementValue}
              ref={inputRef}
              required={required}
              disabled={disabled}
              onBlur={onBlur}
              type={type}
              size={size}
            />
          </div>
          <div className="flex items-center ml-auto">
            <Button
              type="button"
              variant="ghost"
              size={size === 'small' ? 'icon-xs' : 'icon-sm'}
              disabled={disabled}
              onClick={() => {
                handleChange(null);
                setSelectedYear('');
                setSelectedMonth('');
                setSelectedDay('');
                setSelectedHour('');
                setSelectedMinute('');
              }}
            >
              <X className={size === 'small' ? 'size-4' : 'size-5'} />
            </Button>

            <Button
              type="button"
              variant="ghost"
              size={size === 'small' ? 'icon-xs' : 'icon-sm'}
              disabled={disabled}
              onClick={() => setDatePickerOpen(true)}
            >
              <Calendar className={size === 'small' ? 'size-4' : 'size-5'} />
            </Button>
          </div>
        </div>
        <DateTimePickerOverlay
          open={datePickerOpen}
          onClose={() => setDatePickerOpen(false)}
          selectedYear={selectedYear}
          selectedMonth={selectedMonth}
          selectedDay={selectedDay}
          setSelectedYear={setSelectedYear}
          setSelectedMonth={setSelectedMonth}
          setSelectedDay={setSelectedDay}
          selectedHour={selectedHour}
          selectedMinute={selectedMinute}
          setSelectedHour={setSelectedHour}
          setSelectedMinute={setSelectedMinute}
          value={computeValue}
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

export default React.memo(EgDateTimePicker);
