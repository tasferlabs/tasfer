import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "./tooltip";
import { cn } from "@/lib/utils";

// Initialize dayjs plugin
dayjs.extend(relativeTime);

interface RelativeDateProps {
  date: Date | string;
  className?: string;
}

export function RelativeDate({ date, className }: RelativeDateProps) {
  const dateObj = typeof date === "string" ? new Date(date) : date;
  const relativeText = dayjs(dateObj).fromNow();
  const absoluteText = dayjs(dateObj).format("MMM D, YYYY h:mm A");

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("cursor-default", className)}>{relativeText}</span>
        </TooltipTrigger>
        <TooltipContent>{absoluteText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
