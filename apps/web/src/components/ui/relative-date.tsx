import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/ar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "./tooltip";
import { cn } from "@/lib/utils";
import { formatAbsoluteDateTime } from "@/lib/dateTimePreferences";
import { useTranslation } from "react-i18next";

// Initialize dayjs plugin
dayjs.extend(relativeTime);

interface RelativeDateProps {
  date: Date | string;
  className?: string;
}

export function RelativeDate({ date, className }: RelativeDateProps) {
  const { i18n } = useTranslation();
  const locale = i18n.language?.startsWith("ar") ? "ar" : "en";
  const dateObj = typeof date === "string" ? new Date(date) : date;
  const relativeText = dayjs(dateObj).locale(locale).fromNow();
  const absoluteText = formatAbsoluteDateTime(dateObj);

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
