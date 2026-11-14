import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

/**
 * How far (px) the fade reaches into the row from an edge with hidden content.
 * A toolbar button's icon sits in the middle of a 44px slot, so a narrower fade
 * would only dim the empty padding and never reach an icon.
 */
const FADE_WIDTH = 96;

/**
 * Fade out the edge of a horizontal scroll row that has more content past it,
 * so a row that looks full still reads as scrollable. Each side fades only
 * while something is hidden there, and the check follows the row's own
 * direction (an RTL row starts on the right).
 *
 * Returns a callback ref for the scroll container and the mask style to put on
 * it. The fade is a CSS mask, so it works over any background and leaves
 * taps on the faded buttons untouched.
 */
export function useScrollEdgeFade<T extends HTMLElement>(): {
  ref: (element: T | null) => void;
  style: CSSProperties | undefined;
} {
  const [element, setElement] = useState<T | null>(null);
  const [hidden, setHidden] = useState({ left: false, right: false });
  const frame = useRef(0);

  const measure = useCallback((target: T) => {
    const { scrollLeft, scrollWidth, clientWidth } = target;
    const rtl = getComputedStyle(target).direction === "rtl";
    // In RTL, scrollLeft runs from 0 (scrolled to the start, on the right)
    // down to negative values as the row scrolls left.
    const fromLeft = rtl ? scrollWidth - clientWidth + scrollLeft : scrollLeft;
    const next = {
      left: fromLeft > 1,
      right: fromLeft + clientWidth < scrollWidth - 1,
    };
    setHidden((current) =>
      current.left === next.left && current.right === next.right
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    if (!element) return;
    const schedule = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => measure(element));
    };
    measure(element);
    element.addEventListener("scroll", schedule, { passive: true });
    // The row's own size and its buttons coming and going both change what fits.
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const children = new MutationObserver(schedule);
    children.observe(element, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame.current);
      element.removeEventListener("scroll", schedule);
      resize.disconnect();
      children.disconnect();
    };
  }, [element, measure]);

  let style: CSSProperties | undefined;
  if (hidden.left || hidden.right) {
    const left = hidden.left ? `transparent, #000 ${FADE_WIDTH}px` : "#000";
    const right = hidden.right
      ? `#000 calc(100% - ${FADE_WIDTH}px), transparent`
      : "#000";
    const mask = `linear-gradient(to right, ${left}, ${right})`;
    style = { maskImage: mask, WebkitMaskImage: mask };
  }
  return { ref: setElement, style };
}
