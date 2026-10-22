import { cn } from '@/lib/utils';
import React from 'react';

const firstLetter = (text: string) => Array.from(text.toLocaleLowerCase())[0] ?? '';

/**
 * The AM/PM segment of a 12-hour time. Not a text field: it holds one of two
 * values, so ArrowUp/ArrowDown, a click or a tap flips it, and typing `a`/`p`
 * (or the first letter of the locale's own words, `ص`/`م` in Arabic) picks one.
 */
export const DayPeriodInput = React.forwardRef<
  HTMLSpanElement,
  {
    pm: boolean;
    /** The locale's words for the two halves of the day. */
    labels: { am: string; pm: string };
    /** No hour yet: shows the half the next typed hour will land in, dimmed like a placeholder. */
    empty: boolean;
    onChange: (pm: boolean) => void;
    jumpToNext?: () => void;
    jumpToPrevious?: () => void;
    disabled?: boolean;
    onFocus: () => void;
    size?: 'small' | 'medium';
    className?: string;
  }
>(({ pm, labels, empty, onChange, jumpToNext, jumpToPrevious, disabled, onFocus, size = 'medium', className }, ref) => {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (disabled) return;
    // In RTL, ArrowLeft visually moves to the next field (logical forward),
    // ArrowRight visually moves to the previous field (logical backward)
    const isRtl = document.documentElement.dir === 'rtl';
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
        e.preventDefault();
        onChange(!pm);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        (isRtl ? jumpToNext : jumpToPrevious)?.();
        return;
      case 'ArrowRight':
        e.preventDefault();
        (isRtl ? jumpToPrevious : jumpToNext)?.();
        return;
      case 'Backspace':
        e.preventDefault();
        jumpToPrevious?.();
        return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    const key = e.key.toLocaleLowerCase();
    const amLetter = firstLetter(labels.am);
    const pmLetter = firstLetter(labels.pm);
    // Locales whose two words start alike (Korean 오전/오후) only get a/p.
    const distinct = amLetter !== pmLetter;
    if (key === 'a' || (distinct && key === amLetter)) {
      e.preventDefault();
      onChange(false);
    } else if (key === 'p' || (distinct && key === pmLetter)) {
      e.preventDefault();
      onChange(true);
    }
  };

  const label = pm ? labels.pm : labels.am;
  const width = Math.max(Array.from(labels.am).length, Array.from(labels.pm).length);

  return (
    <div className="font-mono">
      <span
        ref={ref}
        role="spinbutton"
        aria-valuetext={label}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
        onClick={(e) => {
          // Keeps the picker's own click handler from moving focus elsewhere.
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          if (!disabled) onChange(!pm);
        }}
        className={cn(
          'inline-block cursor-default select-none whitespace-nowrap text-center outline-none font-mono',
          'focus:bg-[color:Highlight] focus:text-[color:HighlightText]',
          empty || disabled ? 'text-muted-foreground' : 'text-foreground',
          size === 'small' ? 'text-sm leading-6' : 'text-base leading-7',
          className
        )}
        style={{ minWidth: `${width}ch` }}
      >
        {label}
      </span>
    </div>
  );
});
