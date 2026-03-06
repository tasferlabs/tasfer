/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from 'react';

interface KeyboardAction {
  key: 'printable' | string | string[];
  action: (ev: KeyboardEvent, keys?: string) => void;
  clearTimeout?: number;
  target?: React.RefObject<HTMLElement | Window | null>;
  condition?: boolean;
}

export function useKeyboardAction(keyboardAction: KeyboardAction): void {
  const clearPrintableTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const printableRef = useRef('');

  useEffect(() => {
    const EventTarget = keyboardAction?.target?.current;
    const condition = keyboardAction.condition ?? true;

    if (!condition || !EventTarget) return;

    let handler: ((ev: KeyboardEvent) => void) | null = null;
    if (keyboardAction.key === 'printable') {
      handler = (ev: KeyboardEvent) => {
        if (ev.key.length === 1 && !ev.ctrlKey) {
          if (clearPrintableTimeoutRef.current) clearTimeout(clearPrintableTimeoutRef.current);
          clearPrintableTimeoutRef.current = setTimeout(() => {
            printableRef.current = '';
          }, (keyboardAction as any).clearTimeout || 750);
          printableRef.current += ev.key;

          keyboardAction.action(ev, printableRef.current);
        }
      };
    } else if (typeof keyboardAction.key === 'string') {
      handler = (ev: KeyboardEvent) => {
        if (ev.code === keyboardAction.key) {
          keyboardAction.action(ev);
        }
      };
    } else if (Array.isArray(keyboardAction.key)) {
      handler = (ev: KeyboardEvent) => {
        if ((keyboardAction.key as string[]).some((key) => key === ev.code)) {
          keyboardAction.action(ev, '');
        }
      };
    }

    if (handler) (EventTarget as HTMLElement).addEventListener('keydown', handler);
    return () => {
      if (handler) (EventTarget as HTMLElement).removeEventListener('keydown', handler);
    };
  }, [keyboardAction]);
}
