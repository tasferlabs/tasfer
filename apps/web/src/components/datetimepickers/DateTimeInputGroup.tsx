import { DateTime } from 'luxon';
import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DateTimeInput } from './DateTimeInput';
import { DayPeriodInput } from './DayPeriodInput';
import {
  toNumberOrNull,
  getGranularityMaxValue,
  padValue,
  getDateFieldOrder,
  getResolved12h,
  getLocalizedDayPeriod,
  isDayPeriodBeforeHour,
  to12Hour,
  to24Hour,
} from './utils';
import { useDateTimePrefs } from '@/app/contexts/DateTimePrefsContext';

type Segment = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'period';

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
    const periodRef = useRef<HTMLSpanElement>(null);

    // Recomputed when the date order or the clock format moves, here or on another device.
    const dateTimePrefs = useDateTimePrefs();
    const { i18n } = useTranslation();
    const locale = i18n.language;
    const { fields, separator } = useMemo(
      () => getDateFieldOrder(),
      [dateTimePrefs, locale],
    );
    const is12h = useMemo(() => getResolved12h(), [dateTimePrefs, locale]);
    const dayPeriods = useMemo(
      () => ({ am: getLocalizedDayPeriod(true, locale), pm: getLocalizedDayPeriod(false, locale) }),
      [locale]
    );
    const periodFirst = useMemo(() => isDayPeriodBeforeHour(locale), [locale]);

    // On a 12-hour clock the hour field shows 1–12 and an AM/PM segment sits
    // beside it, but `selectedHour` stays 0–23 both ways in and out.
    const hourNum = toNumberOrNull(selectedHour);
    // The half a typed hour lands in while there is no hour yet.
    const [emptyHourPm, setEmptyHourPm] = useState(false);
    const isPm = hourNum === null ? emptyHourPm : hourNum >= 12;
    // The blur handler of the hour field runs a frame late; it must see the
    // half chosen since, not the one at blur time.
    const isPmRef = useRef(isPm);
    isPmRef.current = isPm;
    // Digits as typed ("1" on the way to "12"), shown while they still
    // describe the hour; any other change shows the hour afresh.
    const [typedHour, setTypedHour] = useState<{ text: string; hour: number | null } | null>(null);
    const hourDisplay = !is12h
      ? selectedHour
      : typedHour && typedHour.hour === hourNum
        ? typedHour.text
        : hourNum === null
          ? ''
          : padValue(to12Hour(hourNum).toString(), 'hour');

    const handleHour12Change = (text: string) => {
      const num = toNumberOrNull(text);
      const hour = num === null ? null : to24Hour(num, isPmRef.current);
      setTypedHour({ text, hour });
      setSelectedHour(hour === null ? '' : padValue(hour.toString(), 'hour'));
    };

    const setPeriod = (pm: boolean) => {
      setEmptyHourPm(pm);
      if (hourNum !== null && pm !== isPm) {
        setSelectedHour(padValue(((hourNum + 12) % 24).toString(), 'hour'));
      }
    };

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

    // Every shown field in the order it is shown, for arrow and Backspace moves.
    const segmentRefs: Record<Segment, React.RefObject<{ focus: () => void } | null>> = {
      year: yearRef,
      month: monthRef,
      day: dayRef,
      hour: hourRef,
      minute: minuteRef,
      period: periodRef,
    };
    const timeSegments: Segment[] = !is12h
      ? ['hour', 'minute']
      : periodFirst
        ? ['period', 'hour', 'minute']
        : ['hour', 'minute', 'period'];
    const segments: Segment[] = [
      ...(type === 'time' ? [] : fields),
      ...(type === 'date' ? [] : timeSegments),
    ];
    const jumpFrom = (segment: Segment, step: 1 | -1) => {
      const target = segments[segments.indexOf(segment) + step];
      return target ? () => segmentRefs[target].current?.focus() : undefined;
    };

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
    const [focusOn, setFocusOn] = useState<Segment | null>(null);
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

    const periodSegment = is12h && (
      <DayPeriodInput
        ref={periodRef}
        pm={isPm}
        labels={dayPeriods}
        empty={hourNum === null}
        onChange={setPeriod}
        jumpToNext={jumpFrom('period', 1)}
        jumpToPrevious={jumpFrom('period', -1)}
        disabled={disabled}
        onFocus={() => setFocusOn('period')}
        size={size}
        className={className}
      />
    );

    return (
      <div className="flex flex-row items-center gap-1">
        {(type === 'datetime' || type === 'date') && (
          <>
            {fields.map((field, index) => {
              const config = fieldMap[field];

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
                    jumpToNext={jumpFrom(field, 1)}
                    jumpToPrevious={jumpFrom(field, -1)}
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
            {periodFirst && periodSegment}
            <DateTimeInput
              granularity="hour"
              value={hourDisplay}
              onChange={is12h ? handleHour12Change : (e) => setSelectedHour(e)}
              hour12={is12h}
              year={toNumberOrNull(selectedYear) || 0}
              month={toNumberOrNull(selectedMonth) || 0}
              incrementValue={incrementValue}
              jumpToNext={jumpFrom('hour', 1)}
              jumpToPrevious={jumpFrom('hour', -1)}
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
              jumpToNext={jumpFrom('minute', 1)}
              jumpToPrevious={jumpFrom('minute', -1)}
              ref={minuteRef}
              required={required}
              disabled={disabled}
              onFocus={() => setFocusOn('minute')}
              size={size}
              className={className}
            />
            {!periodFirst && periodSegment}
          </>
        )}
      </div>
    );
  }
);
