import { cn } from "@/lib/utils";
import { Command } from "cmdk";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { DateTime } from "luxon";
import { Popover } from "radix-ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  buildZoneEntries,
  cityLabel,
  filterZones,
  formatGmtOffset,
  pushRecentZone,
  readRecentZones,
  timeOfDayColor,
  withZone,
  zoneOffsetMinutes,
  type ZoneEntry,
} from "./timezoneData";

/**
 * Searchable time-zone picker. The list shows each zone's live local time
 * with a time-of-day dot. Search accepts city names, localized zone names,
 * and offsets ("+2", "gmt-5", "utc+5:30").
 */
export function TimezonePicker({
  value,
  onChange,
  disabled,
  className,
}: {
  /** IANA zone identifier, e.g. "Europe/Stockholm". */
  value: string;
  onChange: (zoneId: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || "en";
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [search, setSearch] = useState("");
  const [highlighted, setHighlighted] = useState("");
  const [recents, setRecents] = useState<string[]>([]);
  const [now, setNow] = useState(() => DateTime.local());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Minute-aligned tick so the trigger and list times stay live.
  useEffect(() => {
    let timeout: number;
    const schedule = () => {
      timeout = window.setTimeout(
        () => {
          setNow(DateTime.local());
          schedule();
        },
        60_000 - (Date.now() % 60_000) + 250,
      );
    };
    schedule();
    return () => window.clearTimeout(timeout);
  }, []);

  // Building the full zone list instantiates one formatter per zone, so it
  // is deferred until the picker is first opened.
  const baseEntries = useMemo(
    () => (everOpened ? buildZoneEntries(locale) : []),
    [everOpened, locale],
  );
  const entries = useMemo(
    () => (everOpened ? withZone(baseEntries, value) : []),
    [everOpened, baseEntries, value],
  );

  const offsets = useMemo(
    () => new Map(entries.map((entry) => [entry.id, zoneOffsetMinutes(entry.id, now)])),
    [entries, now],
  );

  const sorted = useMemo(
    () =>
      [...entries].sort(
        (a, b) =>
          (offsets.get(a.id) ?? 0) - (offsets.get(b.id) ?? 0) ||
          a.city.localeCompare(b.city),
      ),
    [entries, offsets],
  );

  const filtered = useMemo(
    () => filterZones(sorted, search, offsets),
    [sorted, search, offsets],
  );

  const byId = useMemo(() => {
    const map = new Map<string, ZoneEntry>();
    for (const entry of entries) map.set(entry.id.toLowerCase(), entry);
    return map;
  }, [entries]);

  const localZoneId = useMemo(() => DateTime.local().zoneName, []);
  const pinned = useMemo(() => {
    const ids = [localZoneId, ...recents];
    const seen = new Set<string>();
    const result: ZoneEntry[] = [];
    for (const id of ids) {
      const entry = byId.get(id.toLowerCase());
      if (entry && !seen.has(entry.id)) {
        seen.add(entry.id);
        result.push(entry);
      }
    }
    return result;
  }, [localZoneId, recents, byId]);

  // One shared formatter: a zone's wall time is (UTC now + offset) read as UTC.
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
      }),
    [locale],
  );
  const zoneTime = useCallback(
    (offsetMinutes: number) =>
      timeFormatter.format(new Date(now.toMillis() + offsetMinutes * 60_000)),
    [timeFormatter, now],
  );
  const zoneHour = useCallback(
    (offsetMinutes: number) =>
      (now.toUTC().hour + now.toUTC().minute / 60 + offsetMinutes / 60 + 24) % 24,
    [now],
  );

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setEverOpened(true);
      const storedRecents = readRecentZones();
      setRecents(storedRecents);
      // Highlight the pinned copy when there is one, so opening lands on the
      // Suggested group instead of scrolling past it into the full list.
      const isPinned = value === localZoneId || storedRecents.includes(value);
      setHighlighted(`${isPinned ? "pinned" : "all"}:${value}`);
    } else {
      setSearch("");
    }
  };

  const handleSearchChange = (nextSearch: string) => {
    setSearch(nextSearch);
    // Results change entirely, so any previous scroll position is stale.
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: 0 });
    });
  };

  const handleSelect = (itemValue: string) => {
    const zoneId = itemValue.slice(itemValue.indexOf(":") + 1);
    const entry = byId.get(zoneId.toLowerCase());
    if (!entry) return;
    pushRecentZone(entry.id);
    onChange(entry.id);
    setOpen(false);
    setSearch("");
  };

  const selectedOffset = zoneOffsetMinutes(value, now);

  const renderRow = (entry: ZoneEntry, prefix: string) => {
    const offset = offsets.get(entry.id) ?? 0;
    const isSelected = entry.id === value;
    return (
      <Command.Item
        key={`${prefix}:${entry.id}`}
        value={`${prefix}:${entry.id}`}
        onSelect={handleSelect}
        className={cn(
          "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm select-none",
          "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
        )}
      >
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full ring-1 ring-foreground/15"
          style={{ background: timeOfDayColor(zoneHour(offset)) }}
        />
        <span className="truncate">{entry.city}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatGmtOffset(offset)}
        </span>
        <span className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">
          {zoneTime(offset)}
        </span>
        {isSelected && <CheckIcon className="size-4 shrink-0" />}
      </Command.Item>
    );
  };

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={t("timezone.pickerLabel", "Time zone")}
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] dark:bg-input/30",
            "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            disabled && "pointer-events-none opacity-50",
            className,
          )}
        >
          <span className="truncate">{cityLabel(value)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatGmtOffset(selectedOffset)}
          </span>
          <span className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {zoneTime(selectedOffset)}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            "z-50 w-[min(21rem,var(--radix-popover-content-available-width))] overflow-hidden rounded-md bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10",
            "animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
          )}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Command
            shouldFilter={false}
            value={highlighted}
            onValueChange={setHighlighted}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground"
          >
            <Command.Input
              ref={inputRef}
              value={search}
              onValueChange={handleSearchChange}
              className="h-8 w-full border-b border-input/30 bg-input/30 px-3 text-sm outline-none placeholder:text-muted-foreground"
              placeholder={t(
                "timezone.searchPlaceholder",
                "Search city or GMT offset…",
              )}
            />
            <Command.List
              ref={listRef}
              className="no-scrollbar max-h-56 overflow-y-auto overscroll-contain p-1"
            >
              <Command.Empty className="px-3 py-3 text-center text-sm text-muted-foreground">
                {t(
                  "timezone.noResults",
                  "No matches. Try a city name or an offset like GMT+2.",
                )}
              </Command.Empty>
              {search.trim() === "" ? (
                <>
                  {pinned.length > 0 && (
                    <Command.Group
                      heading={t("timezone.suggested", "Suggested")}
                    >
                      {pinned.map((entry) => renderRow(entry, "pinned"))}
                    </Command.Group>
                  )}
                  <Command.Group
                    heading={t("timezone.allZones", "All time zones")}
                  >
                    {sorted.map((entry) => renderRow(entry, "all"))}
                  </Command.Group>
                </>
              ) : (
                filtered.map((entry) => renderRow(entry, "all"))
              )}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
