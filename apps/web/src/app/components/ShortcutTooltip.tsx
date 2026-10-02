import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { useShortcutChords } from "@/shortcuts/ShortcutsContext";
import { CommandKeys } from "./ShortcutKeys";

/**
 * Hover tooltip for an icon button that also has a keyboard shortcut: the
 * button's label with the chord beside it, so the shortcut can be found from
 * the button it stands in for. `commandId` names the shortcut command (see
 * `@/shortcuts/commands`), so the chord shown is the one the person bound; a
 * command left unbound shows the label alone. The child is the trigger and
 * must accept a ref.
 */
export function ShortcutTooltip({
  label,
  commandId,
  children,
}: {
  label: string;
  commandId: string;
  children: ReactNode;
}) {
  const bound = useShortcutChords(commandId).length > 0;
  return (
    <TooltipProvider delayDuration={500}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent className="flex items-center gap-2">
          <span>{label}</span>
          {bound && <CommandKeys id={commandId} />}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
