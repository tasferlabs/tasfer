import type { SVGProps } from "react";

const ErrorStateIllustration = (props: SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 647 511" {...props}>
    <circle cx={310} cy={256} r={238} fill="currentColor" fillOpacity={0.1} />
    <g filter="url(#a)">
      <path fill="#000" fillOpacity={0.3} d="M99 342h423v70H99z" />
    </g>
    <path fill="currentColor" fillOpacity={0.2} d="M125 112h370v261c0 8-6 14-14 14H139c-8 0-14-6-14-14V112Z" />
    <path stroke="currentColor" strokeOpacity={0.5} strokeLinecap="round" strokeWidth={15} d="M286 282h48" />
    <circle cx={370.5} cy={201.5} r={12.5} fill="currentColor" fillOpacity={0.5} />
    <circle cx={250.5} cy={201.5} r={12.5} fill="currentColor" fillOpacity={0.5} />
    <path
      fill="currentColor"
      fillOpacity={0.8}
      fillRule="evenodd"
      d="M140 89c-8 0-15 7-15 15v8h370v-8c0-8-7-15-15-15H140Zm4 17a5 5 0 1 0 0-11 5 5 0 0 0 0 11Zm19-5a5 5 0 1 1-11 0 5 5 0 0 1 11 0Zm9 5a5 5 0 1 0 0-11 5 5 0 0 0 0 11Z"
      clipRule="evenodd"
    />
    <path
      stroke="currentColor"
      strokeOpacity={0.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={9}
      d="M540 121h102M518 94l31-34 31-35M477 68V5"
    />
    <defs>
      <filter
        id="a"
        width={621}
        height={268}
        x={0}
        y={243}
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity={0} result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_79_49" stdDeviation={49.5} />
      </filter>
    </defs>
  </svg>
);

export default ErrorStateIllustration;

