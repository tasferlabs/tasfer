import { type SVGProps, memo } from "react";

const NotFoundStateIllustration = ({ ...props }: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 450 479"
    {...props}
  >
    <rect
      width={225.1}
      height={345.3}
      x={1.8}
      y={92.5}
      fill="var(--muted)"
      stroke="var(--foreground)"
      strokeDasharray="15 15"
      strokeLinejoin="round"
      strokeWidth={3}
      rx={32.5}
      transform="rotate(-11 2 92)"
    />
    <path
      fill="var(--background)"
      d="M302 429 73 401q-11-3-12-15l41-330q3-11 15-11l173 21 61 78-34 274q-2 12-15 11"
    />
    <path
      stroke="var(--foreground)"
      strokeLinejoin="round"
      strokeWidth={5}
      d="m351 144-61-78-173-21q-12 0-15 11L61 386q1 12 12 15l229 28q13 0 15-11zm-61-78c-2 15-7 49-7 60q0 10 10 12l58 6"
    />
    <path
      stroke="var(--foreground)"
      strokeLinecap="round"
      strokeWidth={4}
      d="m165 241 13 1m77 10-15-2m-11-1-16-2m-9-1-13-2"
    />
    <path
      stroke="var(--foreground) "
      strokeDasharray="16 16"
      strokeWidth={4}
      d="m145 186 142 17-17 139-142-17z"
    />
    <path
      stroke="var(--foreground)"
      strokeLinecap="round"
      strokeWidth={4}
      d="m161 275 13 1m26 4-13-2"
    />
    <path
      stroke="var(--primary)"
      strokeLinecap="round"
      strokeWidth={4}
      d="m251 286-15-2m-11-1-16-2"
    />
    <path
      fill="var(--background)"
      stroke="var(--foreground)"
      strokeLinejoin="round"
      strokeWidth={5}
      d="m351 144-61-78c-2 15-7 49-7 60q0 10 10 12z"
    />
    <circle
      cx={352.6}
      cy={378.6}
      r={58.9}
      stroke="var(--foreground)"
      strokeWidth={9}
    />
    <path
      stroke="var(--primary)"
      strokeLinecap="round"
      strokeWidth={10}
      d="M314 395a46 46 0 0 1 26-57"
    />
    <path
      fill="var(--foreground)"
      d="M445 462a10 10 0 1 1-14 14l-44-44q8-5 15-13z"
    />
  </svg>
);
const Memo = memo(NotFoundStateIllustration);
export default Memo;
