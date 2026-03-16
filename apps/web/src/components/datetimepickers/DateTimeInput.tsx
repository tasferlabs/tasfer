import { cn } from '@/lib/utils';
import { DateTime } from 'luxon';
import React, { useImperativeHandle, useRef } from 'react';
import { useKeyboardAction } from './useKeyboardAction';
import {
  getGranularityMaxValue,
  getGranularityMinValue,
  getGranularityPlaceholder,
  padValue,
  toNumberOrNull,
} from './utils';

export const DateTimeInput = React.forwardRef(
  (
    {
      granularity,
      value,
      onChange,
      jumpToNext,
      jumpToPrevious,
      year,
      month,
      required,
      disabled,
      onFocus,
      onBlur,
      incrementValue,
      size = 'medium',
      className,
    }: {
      granularity: keyof DateTime<boolean>;
      value: string;
      onChange: (value: string) => void;
      jumpToNext?: () => void;
      jumpToPrevious?: () => void;
      year: number;
      month: number;
      required?: boolean;
      disabled?: boolean;
      onBlur?: (ev: React.FocusEvent<HTMLInputElement>) => void;
      onFocus: () => void;
      helperText?: React.ReactNode;
      incrementValue: (granularity: keyof DateTime<boolean>, value: number) => void;
      size?: 'small' | 'medium';
      className?: string;
    },
    ref
  ) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const prevValue = useRef<string>(value);

    function handleChange(value: string, pad = false, _overflowOrUnderflow = false, focusNext = true) {
      const regex = RegExp(/[^0-9]/g);

      if (regex.test(value)) {
        return;
      }

      const valueNum = toNumberOrNull(value) || 0;
      const minValue = getGranularityMinValue(granularity);
      const maxValue =
        granularity === 'day'
          ? year && month
            ? getGranularityMaxValue(granularity, year, month)
            : 31
          : getGranularityMaxValue(granularity);

      if (value === '0'.repeat(getGranularityPlaceholder(granularity).length)) {
        if (granularity !== 'hour' && granularity !== 'minute') {
          onChange(padValue('1', granularity));
        } else {
          onChange(padValue('0', granularity));
        }
      } else if (valueNum <= maxValue && valueNum >= minValue) {
        if (pad) {
          onChange(padValue(value, granularity));
        } else {
          onChange(value);
        }
      } else if (valueNum > maxValue) {
        onChange(padValue(maxValue.toString(), granularity));
      } else if (valueNum < minValue && value !== '' && pad) {
        onChange(padValue(minValue.toString(), granularity));
      } else {
        onChange(value);
      }

      if (
        focusNext &&
        getGranularityPlaceholder(granularity).length === value.length &&
        prevValue.current.length !== value.length
      ) {
        jumpToNext?.();
      }
      prevValue.current = value;
    }
    useKeyboardAction({
      target: inputRef,
      action: (e) => {
        e.preventDefault();
        incrementValue(granularity, 1);
      },
      key: 'ArrowUp',
    });
    useKeyboardAction({
      target: inputRef,
      action: (e) => {
        e.preventDefault();
        incrementValue(granularity, -1);
      },
      key: 'ArrowDown',
    });
    // In RTL, ArrowLeft visually moves to the next field (logical forward),
    // ArrowRight visually moves to the previous field (logical backward)
    const isRtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
    const onArrowLeft = isRtl ? jumpToNext : jumpToPrevious;
    const onArrowRight = isRtl ? jumpToPrevious : jumpToNext;

    useKeyboardAction({
      target: inputRef,
      action: (e) => {
        const element = e.currentTarget as HTMLInputElement;

        if (element?.selectionStart === element?.selectionEnd && element?.selectionStart === 0) {
          onArrowLeft?.();
          e.preventDefault();
        }
      },
      key: 'ArrowLeft',
    });
    useKeyboardAction({
      target: inputRef,
      action: (e) => {
        const element = e.currentTarget as HTMLInputElement;

        if (
          element?.selectionStart === element?.selectionEnd &&
          (!element?.value ||
            (element?.value.length === placeholder.length && element?.selectionStart === placeholder.length) ||
            (element.value.length < placeholder.length && element.selectionStart === element.value.length))
        ) {
          onArrowRight?.();
          e.preventDefault();
        }
      },
      key: 'ArrowRight',
    });
    useKeyboardAction({
      target: inputRef,
      action: (e) => {
        const element = e.currentTarget as HTMLInputElement;

        if (element?.selectionStart === element?.selectionEnd && element?.selectionStart === 0) {
          jumpToPrevious?.();
          e.preventDefault();
        }
      },
      key: 'Backspace',
    });

    useImperativeHandle(ref, () => ({ handleChange, focus: () => inputRef.current?.focus() }));
    const placeholder = getGranularityPlaceholder(granularity);
    return (
      <div className='font-mono'>
        <input
          ref={(el) => {
            (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
            if (typeof ref === 'function') ref({ handleChange, focus: () => el?.focus() });
            else if (ref) (ref as React.MutableRefObject<any>).current = { handleChange, focus: () => el?.focus() };
          }}
          type="text"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={placeholder}
          maxLength={placeholder.length}
          onBlur={(ev) => {
            requestAnimationFrame(() => {
              if (inputRef.current?.value) handleChange(inputRef.current.value, true, undefined, false);
            });
            onBlur?.(ev);
          }}
          spellCheck="false"
          onClick={(e) => {
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
          }}
          onFocus={(e) => {
            e.target.select();
            onFocus?.();
          }}
          className={cn(
            'bg-transparent border-none outline-none p-0 font-mono',
            'placeholder:text-muted-foreground',
            disabled ? 'text-muted-foreground' : 'text-foreground',
            size === 'small' ? 'text-sm leading-6' : 'text-base leading-7',
            className
          )}
          style={{ width: `${placeholder.length}ch` }}
          required={required}
          disabled={disabled}
        />
      </div>
    );
  }
);
