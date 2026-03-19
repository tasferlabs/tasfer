import { useState, useRef, useEffect } from "react";
import { Command } from "cmdk";
import { ChevronDown, ChevronRight, FileText, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchPages, type ISearchPage } from "@/app/api/pages.api";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface PagePickerProps {
  spaceId: string | null;
  value?: ISearchPage | null;
  onChange: (page: ISearchPage | null) => void;
  excludeId?: string;
  showNoneOption?: boolean;
  className?: string;
  children?: React.ReactNode;
  popoverWidth?: number | string;
  align?: "start" | "center" | "end";
}

export function PagePicker({
  spaceId,
  value,
  onChange,
  excludeId,
  showNoneOption,
  className,
  children,
  popoverWidth,
  align = "start",
}: PagePickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [anchorWidth, setAnchorWidth] = useState(0);

  const { data: pages } = useSearchPages(spaceId, search);

  const filtered = excludeId
    ? pages?.filter(
        (p) =>
          p.id !== excludeId &&
          !p.path?.some((ancestor) => ancestor.id === excludeId),
      )
    : pages;

  useEffect(() => {
    if (open) {
      setSearch("");
      if (anchorRef.current) {
        setAnchorWidth(anchorRef.current.offsetWidth);
      }
    }
  }, [open]);

  const customTrigger = !!children;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {customTrigger ? (
        <PopoverTrigger asChild>{children}</PopoverTrigger>
      ) : (
        <PopoverAnchor asChild>
          <div
            ref={anchorRef}
            className={cn(
              "relative flex h-9 w-full min-w-0 items-center rounded-md border border-input shadow-xs transition-[color,box-shadow] outline-none dark:bg-input/30",
              className,
            )}
          >
            <PopoverTrigger asChild>
              <button className="flex flex-1 items-center min-w-0 h-full px-2.5 text-sm cursor-pointer">
                <span
                  className={cn(
                    "flex-1 truncate text-start",
                    !value && "text-muted-foreground",
                  )}
                >
                  {value ? value.title || t("common.untitled", "Untitled") : t("common.none", "None")}
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
              <button className="shrink-0 pe-2 ps-1 h-full text-muted-foreground cursor-pointer">
                <ChevronDown size={14} />
              </button>
            </PopoverTrigger>
          </div>
        </PopoverAnchor>
      )}
      <PopoverContent
        className="p-0"
        style={{ width: popoverWidth ?? (customTrigger ? 260 : anchorWidth || undefined) }}
        align={align}
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
            placeholder={t("editor.searchPages", "Search pages...")}
            className="h-9 w-full border-b border-border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
          />
          <Command.List className="max-h-52 overflow-y-auto p-1">
            <Command.Empty className="py-4 text-center text-sm text-muted-foreground">
              {t("page.noPagesFound", "No pages found")}
            </Command.Empty>
            {showNoneOption && (
              <Command.Item
                value="__none__"
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
                className="cursor-pointer flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
              >
                <FileText size={14} className="shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground italic">{t("page.noParent", "No parent (root)")}</span>
              </Command.Item>
            )}
            {filtered?.map((page) => (
              <Command.Item
                key={page.id}
                value={page.id}
                onSelect={() => {
                  onChange(page);
                  setOpen(false);
                }}
                className="cursor-pointer flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm  select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
              >
                <span
                  className="shrink-0 inline-block w-3 h-3 rounded-full"
                  style={{
                    backgroundColor: page.color || "var(--primary)",
                    opacity: page.color ? 1 : 0.3,
                  }}
                />
                <div className="min-w-0 flex-1 flex gap-2">
                  <span className="truncate block">
                    {page.title || t("common.untitled", "Untitled")}
                  </span>
                  {page.path && <PathBreadcrumb path={page.path} />}
                </div>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
function PathBreadcrumb({ path }: { path: { id: string; title: string }[] }) {
  const collapsed = path.length > 2;
  const { t } = useTranslation();

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-0.5 text-xs text-muted-foreground min-w-0 overflow-hidden">
            {collapsed ? (
              <>
                <span className="truncate max-w-[5rem]">{path[0].title || t("common.untitled", "Untitled")}</span>
                <ChevronRight size={10} className="shrink-0 opacity-50" />
                <span className="shrink-0">…</span>
                <ChevronRight size={10} className="shrink-0 opacity-50" />
                <span className="truncate max-w-[5rem]">
                  {path[path.length - 1].title || t("common.untitled", "Untitled")}
                </span>
              </>
            ) : (
              path.map((segment, i) => (
                <span
                  key={segment.id}
                  className="flex items-center gap-0.5 min-w-0"
                >
                  {i > 0 && (
                    <ChevronRight size={10} className="shrink-0 opacity-50" />
                  )}
                  <span className="truncate max-w-[7rem]">{segment.title || t("common.untitled", "Untitled")}</span>
                </span>
              ))
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {path.map((segment, i) => (
              <span key={segment.id} className="flex items-center gap-0.5">
                {i > 0 && (
                  <ChevronRight size={10} className="shrink-0 opacity-50" />
                )}
                <span>{segment.title || t("common.untitled", "Untitled")}</span>
              </span>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
