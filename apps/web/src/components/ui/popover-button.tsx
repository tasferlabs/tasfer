import * as React from "react";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { JSX } from "react";

type ButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "asChild" | "content"
>;

type SharedPopoverButtonProps = {
  content: JSX.Element;
  contentProps?: Omit<React.ComponentProps<typeof PopoverContent>, "children">;
  popoverProps?: Omit<React.ComponentProps<typeof Popover>, "children">;
  showChevron?: boolean;
};

type PopoverButtonProps = ButtonProps &
  SharedPopoverButtonProps &
  (
    | {
        primaryAction: Omit<ButtonProps, "children">;
        popoverTriggerLabel: string;
      }
    | {
        primaryAction?: never;
        popoverTriggerLabel?: never;
      }
  );

function PopoverButton({
  children,
  content,
  contentProps,
  popoverProps,
  primaryAction,
  popoverTriggerLabel,
  showChevron = true,
  ...buttonProps
}: PopoverButtonProps) {
  const popover = (
    <Popover {...popoverProps}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          {...buttonProps}
          aria-label={
            primaryAction ? popoverTriggerLabel : buttonProps["aria-label"]
          }
        >
          {!primaryAction && children}
          {showChevron && (
            <ChevronDownIcon
              aria-hidden="true"
              data-icon="inline-end"
              className="transition-transform group-aria-expanded/button:rotate-180 motion-reduce:transition-none"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-1 py-2" {...contentProps}>
        {content}
      </PopoverContent>
    </Popover>
  );

  if (primaryAction) {
    return (
      <ButtonGroup>
        <Button
          type="button"
          variant={buttonProps.variant}
          size={buttonProps.size}
          {...primaryAction}
          className={cn(
            "border-e-0 disabled:opacity-70",
            primaryAction.className,
          )}
        >
          {children}
        </Button>
        {popover}
      </ButtonGroup>
    );
  }

  return popover;
}

export { PopoverButton, type PopoverButtonProps };
