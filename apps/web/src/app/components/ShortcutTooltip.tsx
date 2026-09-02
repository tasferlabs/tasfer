import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { CommandShortcutKeys } from "./ShortcutKeys";

/**
 * Hover tooltip for an icon button that also has a keyboard shortcut: the
 * button's label with the chord beside it, so the shortcut can be found from
 * the button it stands in for. `commandKey` is the printed key pressed with
 * the platform's command modifier, e.g. ";" for ⌘; / Ctrl+;. The child is the
 * trigger and must accept a ref.
 */
export function ShortcutTooltip({
  label,
  commandKey,
  children,
}: {
  label: string;
  commandKey: string;
  children: ReactNode;
}) {
  return (
    <TooltipProvider delayDuration={500}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent className="flex items-center gap-2">
          <span>{label}</span>
          <CommandShortcutKeys commandKey={commandKey} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
