import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Button,
} from "tasfer";
import { Maximize2 } from "lucide-react";

// Provider is required; defaultOpen renders the hint over the icon button.
export function Open() {
  return (
    <TooltipProvider>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon" aria-label="Fit canvas to screen">
            <Maximize2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Fit canvas to screen</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
