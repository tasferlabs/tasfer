import { DateTime } from 'luxon';
import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { DateTimeInput } from './DateTimeInput';
import { toNumberOrNull, getGranularityMaxValue, padValue, getDateFieldOrder } from './utils';

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

    const { fields, separator } = useMemo(() => getDateFieldOrder(), []);

    const fieldMap = useMemo(
      () => ({
        year: {
          ref: yearRef,
          value: selectedYear,
          onChange: setSelectedYear,
          granularity: 'year' as const,
        },
        month: {
          ref: monthRef,
          value: selectedMonth,
          onChange: setSelectedMonth,
          granularity: 'month' as const,
        },
        day: {
          ref: dayRef,
          value: selectedDay,
          onChange: setSelectedDay,
          granularity: 'day' as const,
        },
      }),
      [selectedYear, selectedMonth, selectedDay, setSelectedYear, setSelectedMonth, setSelectedDay]
    );

    // Build ordered refs for focus navigation
    const orderedDateRefs = useMemo(() => fields.map((f) => fieldMap[f].ref), [fields, fieldMap]);

    useImperativeHandle(ref, () => ({
      focus: () => {
        // Focus the first empty date field in order, or first field
        for (const field of fields) {
          if (!fieldMap[field].value) {
            fieldMap[field].ref.current?.focus();
            return;
          }
        }
        if (!selectedHour) {
          hourRef.current?.focus();
          return;
        }
        if (!selectedMinute) {
          minuteRef.current?.focus();
          return;
        }
        // Default: focus first date field
        orderedDateRefs[0]?.current?.focus();
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

    // Get ref for the field after the last date field (hour or undefined)
    const afterLastDateRef = type === 'datetime' ? hourRef : undefined;
    // Get ref for the field before the first date field (undefined for date fields)
    const beforeFirstDateRef = undefined;

    return (
      <div className="flex flex-row items-center gap-1">
        {(type === 'datetime' || type === 'date') && (
          <>
            {fields.map((field, index) => {
              const config = fieldMap[field];
              const prevRef = index > 0 ? orderedDateRefs[index - 1] : beforeFirstDateRef;
              const nextRef = index < fields.length - 1 ? orderedDateRefs[index + 1] : afterLastDateRef;

              return (
                <React.Fragment key={field}>
                  {index > 0 && (
                    <span className={`text-muted-foreground ${size === 'small' ? 'text-xs' : 'text-sm'}`}>
                      {separator}
                    </span>
                  )}
                  <DateTimeInput
                    granularity={config.granularity}
                    value={config.value}
                    onChange={(e) => config.onChange(e)}
                    year={toNumberOrNull(selectedYear) || 0}
                    month={toNumberOrNull(selectedMonth) || 0}
                    incrementValue={incrementValue}
                    jumpToNext={nextRef ? () => nextRef.current?.focus() : undefined}
                    jumpToPrevious={prevRef ? () => prevRef.current?.focus() : undefined}
                    ref={config.ref}
                    required={required}
                    disabled={disabled}
                    onFocus={() => setFocusOn(field)}
                    onBlur={handleDay}
                    size={size}
                    className={className}
                  />
                </React.Fragment>
              );
            })}
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
                // Jump to last date field
                orderedDateRefs[orderedDateRefs.length - 1]?.current?.focus();
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
