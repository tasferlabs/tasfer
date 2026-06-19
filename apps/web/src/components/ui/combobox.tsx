"use client"

import * as React from "react"
import { Popover } from "radix-ui"
import { Command } from "cmdk"

import { invariant } from "@shared/invariant"
import { cn } from "@/lib/utils"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

// ── Context ──

interface ComboboxContextValue {
  items: string[]
  value: string | null
  onValueChange: (value: string | null) => void
  open: boolean
  setOpen: (open: boolean) => void
  search: string
  setSearch: (search: string) => void
  disabled?: boolean
}

const ComboboxContext = React.createContext<ComboboxContextValue | null>(null)

function useComboboxContext() {
  const ctx = React.useContext(ComboboxContext)
  invariant(ctx, "Combobox components must be used within <Combobox>")
  return ctx
}

// ── Root ──

function Combobox({
  items,
  value,
  onValueChange,
  disabled,
  children,
}: {
  items: string[]
  value: string | null
  onValueChange: (value: string | null) => void
  disabled?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")

  // Reset search when closing
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (!nextOpen) setSearch("")
    },
    [],
  )

  const ctx = React.useMemo<ComboboxContextValue>(
    () => ({ items, value, onValueChange, open, setOpen: handleOpenChange, search, setSearch, disabled }),
    [items, value, onValueChange, open, handleOpenChange, search, disabled],
  )

  return (
    <ComboboxContext.Provider value={ctx}>
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        {children}
      </Popover.Root>
    </ComboboxContext.Provider>
  )
}

// ── Input (trigger + search) ──

function ComboboxInput({
  className,
  placeholder,
  disabled: disabledProp,
  showTrigger = true,
  // ..._props
}: React.ComponentProps<"input"> & {
  showTrigger?: boolean
  showClear?: boolean
}) {
  const ctx = useComboboxContext()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const isDisabled = disabledProp ?? ctx.disabled

  return (
    <Popover.Trigger asChild disabled={isDisabled}>
      <div
        data-slot="combobox-trigger"
        className={cn(
          "flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 shadow-xs transition-[color,box-shadow] dark:bg-input/30",
          "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          isDisabled && "pointer-events-none opacity-50",
          className,
        )}
        onClick={() => {
          if (!isDisabled) {
            ctx.setOpen(true)
            // Focus input after popover opens
            setTimeout(() => inputRef.current?.focus(), 0)
          }
        }}
      >
        <span className="flex-1 truncate text-sm">
          {ctx.value || <span className="text-muted-foreground">{placeholder}</span>}
        </span>
        {showTrigger && (
          <ChevronDownIcon className="ms-1 size-4 shrink-0 text-muted-foreground" />
        )}
      </div>
    </Popover.Trigger>
  )
}

// ── Content (popover dropdown) ──

function ComboboxContent({
  className,
  children,
  ...props
}: {
  className?: string
  children: React.ReactNode
}) {
  const ctx = useComboboxContext()
  const { t } = useTranslation()

  return (
    <Popover.Portal>
      <Popover.Content
        data-slot="combobox-content"
        align="start"
        sideOffset={6}
        className={cn(
          "z-50 w-(--radix-popover-trigger-width) overflow-hidden rounded-md bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10",
          "animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
          className,
        )}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={() => ctx.setOpen(false)}
        {...props}
      >
        <Command shouldFilter={true}>
          <Command.Input
            value={ctx.search}
            onValueChange={ctx.setSearch}
            className="h-8 w-full border-b border-input/30 bg-input/30 px-3 text-sm outline-none placeholder:text-muted-foreground"
            placeholder={t("editor.search", "Search...")}
          />
          {children}
        </Command>
      </Popover.Content>
    </Popover.Portal>
  )
}

// ── List ──

function ComboboxList({
  className,
  children,
}: {
  className?: string
  children: ((item: string) => React.ReactNode) | React.ReactNode
}) {
  const ctx = useComboboxContext()
  const { t } = useTranslation()

  return (
    <Command.List
      data-slot="combobox-list"
      className={cn(
        "no-scrollbar max-h-72 overflow-y-auto overscroll-contain p-1",
        className,
      )}
    >
      <Command.Empty className="flex w-full justify-center py-2 text-center text-sm text-muted-foreground">
        {t("common.noResults", "No results")}
      </Command.Empty>
      {typeof children === "function"
        ? ctx.items.map((item) => (children as (item: string) => React.ReactNode)(item))
        : children}
    </Command.List>
  )
}

// ── Item ──

function ComboboxItem({
  className,
  children,
  value,
  ...props
}: {
  className?: string
  children: React.ReactNode
  value: string
}) {
  const ctx = useComboboxContext()
  const isSelected = ctx.value === value

  return (
    <Command.Item
      data-slot="combobox-item"
      value={value}
      onSelect={() => {
        ctx.onValueChange(value)
        ctx.setOpen(false)
      }}
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pe-8 ps-2 text-sm outline-hidden select-none",
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      {isSelected && (
        <span className="pointer-events-none absolute end-2 flex size-4 items-center justify-center">
          <CheckIcon className="pointer-events-none size-4" />
        </span>
      )}
    </Command.Item>
  )
}

// ── Unused but exported for API compatibility ──

function ComboboxGroup({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <Command.Group data-slot="combobox-group" className={cn(className)} {...props}>
      {children}
    </Command.Group>
  )
}

function ComboboxLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="combobox-label"
      className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function ComboboxEmpty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <Command.Empty
      data-slot="combobox-empty"
      className={cn(
        "flex w-full justify-center py-2 text-center text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

function ComboboxSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <Command.Separator
      data-slot="combobox-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function ComboboxCollection({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

function ComboboxValue(props: React.ComponentProps<"span">) {
  return <span {...props} />
}

function ComboboxTrigger(props: React.ComponentProps<"button">) {
  return <button {...props} />
}

function ComboboxChips({ className, children, ...props }: React.ComponentProps<"div">) {
  return <div className={className} {...props}>{children}</div>
}

function ComboboxChip({ className, children, ...props }: React.ComponentProps<"div">) {
  return <div className={className} {...props}>{children}</div>
}

function ComboboxChipsInput(props: React.ComponentProps<"input">) {
  return <input {...props} />
}

function ComboboxClear(props: React.ComponentProps<"button">) {
  return <button {...props} />
}

function useComboboxAnchor() {
  return React.useRef<HTMLDivElement | null>(null)
}

export {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxSeparator,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  ComboboxTrigger,
  ComboboxValue,
  ComboboxClear,
  useComboboxAnchor,
}
