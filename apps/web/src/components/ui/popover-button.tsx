import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

type PopoverButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "asChild" | "content"
> & {
  content: React.ReactNode
  contentProps?: Omit<
    React.ComponentProps<typeof PopoverContent>,
    "children"
  >
  popoverProps?: Omit<React.ComponentProps<typeof Popover>, "children">
  showChevron?: boolean
}

function PopoverButton({
  children,
  content,
  contentProps,
  popoverProps,
  showChevron = true,
  ...buttonProps
}: PopoverButtonProps) {
  return (
    <Popover {...popoverProps}>
      <PopoverTrigger asChild>
        <Button type="button" {...buttonProps}>
          {children}
          {showChevron && (
            <ChevronDownIcon
              aria-hidden="true"
              data-icon="inline-end"
              className="transition-transform group-aria-expanded/button:rotate-180 motion-reduce:transition-none"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" {...contentProps}>
        {content}
      </PopoverContent>
    </Popover>
  )
}

export { PopoverButton, type PopoverButtonProps }
