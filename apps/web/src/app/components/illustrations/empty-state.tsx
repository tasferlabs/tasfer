import type { SVGProps } from "react";

const EmptyStateIllustration = (props: SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 369 222" {...props}>
    <path fill="currentColor" fillOpacity={0.2} d="M227.5 57V1.5L37 37.5 164.5 67l63-10Zm1-1L340 38.5 228.5 2v54Z" />
    <path
      stroke="currentColor"
      strokeWidth={2}
      d="M164.5 66.5 34.5 38m130 28.5L185 96l157-25.4m-177.5-4.1L144 96 34.5 76.2m130-9.7V220m0-153.5 63-10.1M342 38 227.5 2M342 38l25 28.5-25 4m0-32.5L227.5 56.4m-63 163.6L342 181V70.6M164.5 220l-130-39V76.2m0-38.2 193-36m-193 36L3 70.6l31.5 5.6M227.5 2v54.4"
    />
    <path fill="currentColor" fillOpacity={0.3} d="M164.5 220 342 181v-8.5l-177.5 39v8.5Z" />
    <path stroke="currentColor" strokeLinecap="round" strokeOpacity={0.4} strokeWidth={10} d="m236 154.5 48.5-10.5" />
    <path fill="currentColor" fillOpacity={0.3} d="m35.5 173.5 128 38v7L35.5 182v-8.5Z" />
    <path fill="currentColor" fillOpacity={0.5} d="M35 118.5v-11l71.4 15.5a5.8 5.8 0 1 1-2.5 11.4L35 118.5Z" />
  </svg>
);

export default EmptyStateIllustration;

