import { cn } from "@/lib/utils";
import { Command } from "cmdk";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
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
import useMobileLayout from "@/app/hooks/useMobileLayout";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import {
  buildZoneEntries,
  cityLabel,
  filterZones,
  formatGmtOffset,
  groupZonesByRegion,
  pushRecentZone,
  readRecentZones,
  regionLabelKey,
  timeOfDayColor,
  withZone,
  zoneOffsetMinutes,
  zoneRegion,
  type ZoneEntry,
  type ZoneGroup,
} from "./timezoneData";

/** English fallbacks for the region headings, paired with `regionLabelKey`. */
const REGION_FALLBACKS: Record<string, string> = {
  Africa: "Africa",
  America: "Americas",
  Antarctica: "Antarctica",
  Arctic: "Arctic",
  Asia: "Asia",
  Atlantic: "Atlantic",
  Australia: "Australia",
  Europe: "Europe",
  Indian: "Indian Ocean",
  Pacific: "Pacific",
  UTC: "UTC",
};

/** cmdk value of the "follow the device" row; never a zone id. */
const DEVICE_ITEM = "device:system";

/**
 * Searchable time-zone picker. The list shows each zone's live local time
 * with a time-of-day dot. Search accepts city names, localized zone names,
 * and offsets ("+2", "gmt-5", "utc+5:30").
 *
 * On a touch layout it opens as a bottom sheet instead of a popover: a popover
 * anchored to the trigger leaves ~7 rows of a 400-zone list visible, and the
 * soft keyboard — which Radix cannot position around, since it anchors against
 * the layout viewport — covers what is left. The sheet is nearly full height,
 * lifts its content above the keyboard, and does NOT focus the search field on
 * open, so the list is what you see first and the keyboard only appears if you
 * ask for it. The full list is grouped by region there rather than sorted by
 * offset; see `groupZonesByRegion`.
 */
export function TimezonePicker({
  value,
  onChange,
  isSystem,
  onUseSystem,
  disabled,
  className,
}: {
  /** IANA zone identifier, e.g. "Europe/Stockholm". */
  value: string;
  onChange: (zoneId: string) => void;
  /** Whether the host currently follows the device zone rather than `value`. */
  isSystem?: boolean;
  /**
   * Selects "follow this device" instead of a fixed zone. When given, the list
   * offers it as the first suggestion; otherwise the device zone is suggested
   * as an ordinary fixed zone.
   */
  onUseSystem?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || "en";
  const { isMobile } = useMobileLayout();
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

  // Offsets are keyed to the hour, not to the minute tick: resolving 400 zones
  // and re-sorting them is the expensive part of this list, and a zone's offset
  // only moves at a DST transition — which always lands on an hour boundary.
  const offsetsAt = useMemo(() => now.startOf("hour"), [now]);
  const offsets = useMemo(
    () =>
      new Map(
        entries.map((entry) => [entry.id, zoneOffsetMinutes(entry.id, offsetsAt)]),
      ),
    [entries, offsetsAt],
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

  const regionLabel = useCallback(
    (region: string) => {
      const key = regionLabelKey(region);
      return key ? t(key, REGION_FALLBACKS[region] ?? region) : region;
    },
    [t],
  );

  const groups: ZoneGroup[] = useMemo(
    () =>
      isMobile
        ? groupZonesByRegion(entries, regionLabel, locale)
        : [
            {
              region: "all",
              label: t("timezone.allZones", "All time zones"),
              entries: sorted,
            },
          ],
    [isMobile, entries, regionLabel, locale, sorted, t],
  );

  const byId = useMemo(() => {
    const map = new Map<string, ZoneEntry>();
    for (const entry of entries) map.set(entry.id.toLowerCase(), entry);
    return map;
  }, [entries]);

  const localZoneId = useMemo(() => DateTime.local().zoneName, []);
  const pinned = useMemo(() => {
    // With a device row of its own the device zone is already suggested; as a
    // fixed zone it would read as a duplicate of the row above it.
    const ids = onUseSystem ? recents : [localZoneId, ...recents];
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
  }, [onUseSystem, localZoneId, recents, byId]);

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
  // Zones sharing an offset share a clock face, so the whole list only needs
  // one formatted time and one dot color per distinct offset (~40, not ~400).
  const zoneDisplay = useMemo(() => {
    const cache = new Map<number, { time: string; color: string }>();
    const utc = now.toUTC();
    return (offsetMinutes: number) => {
      let display = cache.get(offsetMinutes);
      if (!display) {
        display = {
          time: timeFormatter.format(
            new Date(now.toMillis() + offsetMinutes * 60_000),
          ),
          color: timeOfDayColor(
            (utc.hour + utc.minute / 60 + offsetMinutes / 60 + 24) % 24,
          ),
        };
        cache.set(offsetMinutes, display);
      }
      return display;
    };
  }, [timeFormatter, now]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setEverOpened(true);
      const storedRecents = readRecentZones();
      setRecents(storedRecents);
      // Highlight the pinned copy when there is one, so opening lands on the
      // Suggested group instead of scrolling past it into the full list. The
      // device zone only has one when it is suggested as a fixed zone.
      const isPinned =
        storedRecents.includes(value) ||
        (!onUseSystem && value === localZoneId);
      setHighlighted(
        isSystem && onUseSystem
          ? DEVICE_ITEM
          : `${isPinned ? "pinned" : "all"}:${value}`,
      );
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
    if (itemValue === DEVICE_ITEM) {
      onUseSystem?.();
      setOpen(false);
      setSearch("");
      return;
    }
    const zoneId = itemValue.slice(itemValue.indexOf(":") + 1);
    const entry = byId.get(zoneId.toLowerCase());
    if (!entry) return;
    pushRecentZone(entry.id);
    onChange(entry.id);
    setOpen(false);
    setSearch("");
  };

  const selectedOffset = zoneOffsetMinutes(value, now);

  /**
   * One list row. `subtitle` is only rendered on the touch layout, where the
   * row is two lines tall to clear a 44px touch target anyway.
   */
  const renderItem = ({
    itemValue,
    offset,
    title,
    subtitle,
    isSelected,
  }: {
    itemValue: string;
    offset: number;
    title: string;
    subtitle: string;
    isSelected: boolean;
  }) => {
    const { time, color } = zoneDisplay(offset);
    return (
      <Command.Item
        key={itemValue}
        value={itemValue}
        onSelect={handleSelect}
        // Off-screen rows skip layout and paint; the row heights are fixed, so
        // the placeholder size is exact and the scrollbar never shifts.
        className={cn(
          "cursor-default select-none [content-visibility:auto]",
          "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
          isMobile
            ? "flex min-h-11 items-center gap-3 rounded-lg px-3 py-1.5 [contain-intrinsic-size:auto_44px]"
            : "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm [contain-intrinsic-size:auto_32px]",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "shrink-0 rounded-full ring-1 ring-foreground/15",
            isMobile ? "size-2.5" : "size-2",
          )}
          style={{ background: color }}
        />
        {isMobile ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px]">{title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {subtitle}
            </span>
          </span>
        ) : (
          <>
            <span className="truncate">{title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatGmtOffset(offset)}
            </span>
          </>
        )}
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums text-muted-foreground",
            !isMobile && "ms-auto",
          )}
        >
          {time}
        </span>
        {isMobile ? (
          <span className="flex size-4 shrink-0 items-center justify-center">
            {isSelected && <CheckIcon className="size-4" />}
          </span>
        ) : (
          isSelected && <CheckIcon className="size-4 shrink-0" />
        )}
      </Command.Item>
    );
  };

  /** `showRegion`: rows in a flat list carry the region their group would name. */
  const renderRow = (entry: ZoneEntry, prefix: string, showRegion = false) => {
    const offset = offsets.get(entry.id) ?? 0;
    const gmt = formatGmtOffset(offset);
    return renderItem({
      itemValue: `${prefix}:${entry.id}`,
      offset,
      title: entry.city,
      subtitle: showRegion
        ? `${regionLabel(zoneRegion(entry.id))} · ${gmt}`
        : gmt,
      isSelected: entry.id === value && !isSystem,
    });
  };

  const deviceRow = onUseSystem
    ? renderItem({
        itemValue: DEVICE_ITEM,
        offset: offsets.get(localZoneId) ?? zoneOffsetMinutes(localZoneId, now),
        title: t("timezone.deviceZone", "Device time zone"),
        subtitle: `${cityLabel(localZoneId)} · ${formatGmtOffset(
          offsets.get(localZoneId) ?? zoneOffsetMinutes(localZoneId, now),
        )}`,
        isSelected: isSystem === true,
      })
    : null;

  const list = (
    <>
      <Command.Empty
        className={cn(
          "px-3 py-3 text-center text-muted-foreground",
          isMobile ? "text-[15px]" : "text-sm",
        )}
      >
        {t(
          "timezone.noResults",
          "No matches. Try a city name or an offset like GMT+2.",
        )}
      </Command.Empty>
      {search.trim() === "" ? (
        <>
          {(deviceRow || pinned.length > 0) && (
            <Command.Group heading={t("timezone.suggested", "Suggested")}>
              {deviceRow}
              {pinned.map((entry) => renderRow(entry, "pinned", true))}
            </Command.Group>
          )}
          {groups.map((group) => (
            <Command.Group key={group.region} heading={group.label}>
              {group.entries.map((entry) => renderRow(entry, "all"))}
            </Command.Group>
          ))}
        </>
      ) : (
        filtered.map((entry) => renderRow(entry, "all", true))
      )}
    </>
  );

  const trigger = (
    <button
      type="button"
      aria-label={t("timezone.pickerLabel", "Time zone")}
      onClick={isMobile ? () => handleOpenChange(true) : undefined}
      disabled={isMobile ? disabled : undefined}
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      <span className="truncate">
        {isSystem
          ? t("timezone.deviceZone", "Device time zone")
          : cityLabel(value)}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatGmtOffset(selectedOffset)}
      </span>
      <ChevronDownIcon className="ms-auto size-4 shrink-0 text-muted-foreground" />
    </button>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        {/* `trapFocus`: the picker is opened from inside the settings drawer,
            whose own focus scope would otherwise pull focus straight back out
            of the search field. */}
        <BottomSheet open={open} onOpenChange={handleOpenChange} trapFocus>
          <Command
            shouldFilter={false}
            value={highlighted}
            onValueChange={setHighlighted}
            label={t("timezone.pickerLabel", "Time zone")}
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              // Sticky headings: with ~400 rows under a thumb, the heading is
              // the only thing telling you where in the list you are.
              "[&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10",
              "[&_[cmdk-group-heading]]:bg-background [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2",
              "[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
            )}
          >
            <div className="shrink-0 px-4 pt-1 pb-3">
              <p className="pb-2 text-base font-medium">
                {t("timezone.pickerLabel", "Time zone")}
              </p>
              <div className="flex h-11 items-center gap-2 rounded-lg bg-muted px-3">
                <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
                {/* Not autofocused: the keyboard would cover the list it is
                    meant to narrow. Tapping the field opens it, and the sheet
                    lifts its content above the keyboard. `text-base` keeps iOS
                    from zooming the page in on focus. */}
                <Command.Input
                  ref={inputRef}
                  value={search}
                  onValueChange={handleSearchChange}
                  className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
                  placeholder={t(
                    "timezone.searchPlaceholder",
                    "Search city or GMT offset…",
                  )}
                />
              </div>
            </div>
            <Command.List
              ref={listRef}
              className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2"
            >
              {list}
            </Command.List>
          </Command>
        </BottomSheet>
      </>
    );
  }

  return (
    // Modal per the layered-surface contract in components/ui/popover.tsx:
    // the background stays inert while the picker is open.
    <Popover.Root modal open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild disabled={disabled}>
        {trigger}
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
          // Escape dismisses only this layer; see the layered-surface
          // contract in components/ui/popover.tsx.
          onEscapeKeyDown={(event) => event.stopPropagation()}
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
              {list}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
