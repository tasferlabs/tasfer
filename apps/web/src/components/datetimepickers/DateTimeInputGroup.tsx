import { DateTime } from 'luxon';
import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { DateTimeInput } from './DateTimeInput';
import { toNumberOrNull, getGranularityMaxValue, padValue } from './utils';

export const DateTimeInputGroup = React.forwardRef(
  (
    {
      selectedYear,
      selectedMonth,
      selectedDay,
      selectedHour,
      selectedMinute,
      setSelectedYear,
      setSelectedMonth,
      setSelectedDay,
      setSelectedHour,
      setSelectedMinute,
      required,
      disabled,
      onBlur,
      type,
      size = 'medium',
      incrementValue,
      className,
    }: {
      selectedYear: string;
      selectedMonth: string;
      selectedDay: string;
      selectedHour: string;
      selectedMinute: string;
      setSelectedYear: (year: string) => void;
      setSelectedMonth: (month: string) => void;
      setSelectedDay: (day: string) => void;
      setSelectedHour: (hour: string) => void;
      setSelectedMinute: (minute: string) => void;
      incrementValue: (granularity: keyof DateTime<boolean>, value: number) => void;
      required?: boolean;
      disabled?: boolean;
      onBlur?: () => void;
      type: 'date' | 'datetime' | 'time';
      size?: 'small' | 'medium';
      className?: string;
      maxDate?: string;
      minDate?: string;
    },
    ref
  ) => {
    const yearRef = useRef<HTMLInputElement>(null);
    const monthRef = useRef<HTMLInputElement>(null);
    const dayRef = useRef<HTMLInputElement>(null);
    const hourRef = useRef<HTMLInputElement>(null);
    const minuteRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      focus: () => {
        if (!selectedYear) {
          yearRef.current?.focus();
          return;
        }
        if (!selectedMonth) {
          monthRef.current?.focus();
          return;
        }
        if (!selectedDay) {
          dayRef.current?.focus();
          return;
        }
        if (!selectedHour) {
          hourRef.current?.focus();
          return;
        }
        if (!selectedMinute) {
          minuteRef.current?.focus();
          return;
        }

        yearRef.current?.focus();
      },
    }));
    const previousFocusOn = useRef<string | null>(null);
    const [focusOn, setFocusOn] = useState<'year' | 'month' | 'day' | 'hour' | 'minute' | null>(null);
    useEffect(() => {
      if (previousFocusOn.current && focusOn === null && !disabled) {
        onBlur?.();
      }

      if (focusOn) {
        previousFocusOn.current = focusOn;
      }
    }, [focusOn, disabled]);

    const handleDay = () => {
      if (selectedYear && selectedMonth) {
        const maxValue = getGranularityMaxValue(
          'day',
          toNumberOrNull(selectedYear) || 1,
          toNumberOrNull(selectedMonth) || 1
        );
        const value = toNumberOrNull(selectedDay);
        if (value && value > maxValue) {
          setSelectedDay(padValue(maxValue.toString(), 'day'));
        }
      }
    };
    return (
      <div className="flex flex-row items-center gap-1">
        {(type === 'datetime' || type === 'date') && (
          <>
            <DateTimeInput
              granularity="year"
              value={selectedYear}
              onChange={(e) => setSelectedYear(e)}
              year={toNumberOrNull(selectedYear) || 0}
              month={toNumberOrNull(selectedMonth) || 0}
              incrementValue={incrementValue}
              jumpToNext={() => {
                monthRef.current?.focus();
              }}
              ref={yearRef}
              required={required}
              disabled={disabled}
              onFocus={() => setFocusOn('year')}
              onBlur={handleDay}
              size={size}
              className={className}
            />
            <span className={`text-muted-foreground ${size === 'small' ? 'text-xs' : 'text-sm'}`}>-</span>
            <DateTimeInput
              granularity="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e)}
              year={toNumberOrNull(selectedYear) || 0}
              month={toNumberOrNull(selectedMonth) || 0}
              incrementValue={incrementValue}
              jumpToNext={() => {
                dayRef.current?.focus();
              }}
              jumpToPrevious={() => {
                yearRef.current?.focus();
              }}
              ref={monthRef}
              required={required}
              disabled={disabled}
              onFocus={() => setFocusOn('month')}
              onBlur={handleDay}
              size={size}
              className={className}
            />
            <span className={`text-muted-foreground ${size === 'small' ? 'text-xs' : 'text-sm'}`}>-</span>
            <DateTimeInput
              granularity="day"
              value={selectedDay}
              onChange={(e) => setSelectedDay(e)}
              year={toNumberOrNull(selectedYear) || 0}
              month={toNumberOrNull(selectedMonth) || 0}
              incrementValue={incrementValue}
              jumpToNext={
                type === 'datetime'
                  ? () => {
                      hourRef.current?.focus();
                    }
                  : undefined
              }
              jumpToPrevious={() => {
                monthRef.current?.focus();
              }}
              ref={dayRef}
              required={required}
              disabled={disabled}
              onFocus={() => setFocusOn('day')}
              size={size}
              className={className}
            />
            <span className={`text-muted-foreground ${size === 'small' ? 'text-xs' : 'text-sm'}`}>&nbsp;</span>
          </>
        )}
        {(type === 'datetime' || type === 'time') && (
          <>
            <DateTimeInput
              granularity="hour"
              value={selectedHour}
              onChange={(e) => setSelectedHour(e)}
              year={toNumberOrNull(selectedYear) || 0}
              month={toNumberOrNull(selectedMonth) || 0}
              incrementValue={incrementValue}
              jumpToNext={() => {
                minuteRef.current?.focus();
              }}
              jumpToPrevious={() => {
                dayRef.current?.focus();
              }}
              ref={hourRef}
              required={required}
              disabled={disabled}
              onFocus={() => setFocusOn('hour')}
              size={size}
              className={className}
            />
            <span className={`text-muted-foreground ${size === 'small' ? 'text-xs' : 'text-sm'}`}>:</span>
            <DateTimeInput
              granularity="minute"
              value={selectedMinute}
              onChange={(e) => setSelectedMinute(e)}
              year={toNumberOrNull(selectedYear) || 0}
              month={toNumberOrNull(selectedMonth) || 0}
              incrementValue={incrementValue}
              jumpToPrevious={() => {
                hourRef.current?.focus();
              }}
              ref={minuteRef}
              required={required}
              disabled={disabled}
              onFocus={() => setFocusOn('minute')}
              size={size}
              className={className}
            />
          </>
        )}
      </div>
    );
  }
);
