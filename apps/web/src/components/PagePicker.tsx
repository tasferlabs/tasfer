import { useState, useRef, useEffect } from "react";
import { Command } from "cmdk";
import { ChevronDown, FileText, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchPages, type ISearchPage } from "@/app/api/pages.api";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface PagePickerProps {
  spaceId: string | null;
  value: ISearchPage | null;
  onChange: (page: ISearchPage | null) => void;
  excludeId?: string;
  className?: string;
}

export function PagePicker({
  spaceId,
  value,
  onChange,
  excludeId,
  className,
}: PagePickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [anchorWidth, setAnchorWidth] = useState(0);

  const { data: pages } = useSearchPages(spaceId, search);

  const filtered = excludeId
    ? pages?.filter((p) => p.id !== excludeId)
    : pages;

  useEffect(() => {
    if (open) {
      setSearch("");
      if (anchorRef.current) {
        setAnchorWidth(anchorRef.current.offsetWidth);
      }
    }
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          className={cn(
            "relative flex h-9 w-full min-w-0 items-center rounded-md border border-input shadow-xs transition-[color,box-shadow] outline-none dark:bg-input/30",
            className,
          )}
        >
          <PopoverTrigger asChild>
            <button
              className="flex flex-1 items-center min-w-0 h-full px-2.5 text-sm cursor-pointer"
            >
              <span className={cn("flex-1 truncate text-left", !value && "text-muted-foreground")}>
                {value ? (value.title || t("Untitled")) : t("None")}
              </span>
            </button>
          </PopoverTrigger>
          {value && (
            <button
              className="shrink-0 px-1 h-full text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={() => onChange(null)}
            >
              <X size={14} />
            </button>
          )}
          <PopoverTrigger asChild>
            <button className="shrink-0 pr-2 pl-1 h-full text-muted-foreground cursor-pointer">
              <ChevronDown size={14} />
            </button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="p-0"
        style={{ width: anchorWidth || undefined }}
        align="start"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <Command shouldFilter={false}>
          <Command.Input
            ref={inputRef}
            value={search}
            onValueChange={setSearch}
            placeholder={t("Search pages...")}
            className="h-9 w-full border-b border-border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
          />
          <Command.List className="max-h-52 overflow-y-auto p-1">
            <Command.Empty className="py-4 text-center text-sm text-muted-foreground">
              {t("No pages found")}
            </Command.Empty>
            {filtered?.map((page) => (
              <Command.Item
                key={page.id}
                value={page.id}
                onSelect={() => {
                  onChange(page);
                  setOpen(false);
                }}
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-default select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
              >
                <FileText size={14} className="shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {page.title || t("Untitled")}
                </span>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
