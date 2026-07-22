import type { SVGProps } from "react";

/**
 * The tasfer sifr mark — the word صفر (zero) drawn as a single calligraphic
 * stroke. Keep the path in sync with brand/logo.svg. Fill follows the themed
 * --brand-mark-color token (#43a047 on light surfaces, #66bb6a on dark).
 *
 * The svg scales like `object-fit: contain` inside whatever box the caller's
 * CSS gives it (default xMidYMid meet), so square icon boxes work as-is.
 */
export default function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 100 140" fill="none" aria-hidden="true" {...props}>
      <path
        d="M 57 4 Q 79 34 83 66 Q 58 98 41 136 Q 30 98 17 64 Q 39 32 57 4 Z"
        fill="var(--brand-mark-color)"
      />
    </svg>
  );
}
