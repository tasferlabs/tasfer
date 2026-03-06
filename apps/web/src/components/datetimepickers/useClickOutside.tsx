import { type RefObject, useEffect } from 'react';

export interface OutsideClickArgs {
  element: RefObject<Element>;
  action: (ev: MouseEvent) => void;
  condition: boolean;
}

export function useOutsideClick({ element, action, condition }: OutsideClickArgs): void {
  useEffect(() => {
    function handleClickOutside(ev: MouseEvent) {
      if (!element.current || element.current.contains(ev.target as Node)) {
        return;
      }

      action(ev);
    }

    if (condition) document.addEventListener('click', handleClickOutside);

    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [element, action, condition]);
}
