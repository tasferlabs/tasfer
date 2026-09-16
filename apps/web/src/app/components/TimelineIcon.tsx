import { createLucideIcon } from "lucide-react";

/**
 * The Timeline's icon: two parallel vertical lines, each with an event circle
 * on it at a different height, reading as two timelines running side by side.
 * Built with Lucide's factory so it takes the same props (size, strokeWidth).
 */
export const TimelineIcon = createLucideIcon("timeline", [
  ["circle", { cx: "8", cy: "9", r: "2.5", key: "left-event" }],
  ["circle", { cx: "16", cy: "15", r: "2.5", key: "right-event" }],
  ["path", { d: "M8 3v3.5M8 11.5V21", key: "left-line" }],
  ["path", { d: "M16 3v9.5M16 17.5V21", key: "right-line" }],
]);
