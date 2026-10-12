import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Repeat } from "lucide-react";
import { DateTime } from "luxon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import DateTimePicker from "@/components/datetimepickers/DateTimePicker";
import {
  WEEKDAY_CODES,
  formatRecurrence,
  monthlyOrdinalOf,
  parseRecurrence,
  type RecurrenceFreq,
  type RecurrenceRule,
  type WeekdayCode,
} from "@/platform/recurrence";
import {
  baseRule,
  describePattern,
  describeRecurrence,
  repeatPresets,
  samePattern,
  weekdayName,
  withEnd,
} from "./recurrenceLabels";

const NONE = "none";
const CURRENT = "current";
const CUSTOM = "custom";

/**
 * The "Repeat" row of an event's panel: one-tap patterns read off the event's
 * start, and Custom for an interval, weekdays, or an end.
 */
export function RepeatRow({
  value,
  start,
  timezone,
  onChange,
  className,
  iconClassName,
  iconSize = 14,
  icon = true,
}: {
  /** The stored rule, or null for an event that doesn't repeat. */
  value: string | null;
  /** The series' first start (an occurrence shows its series' rule). */
  start: string;
  /** Zone a new rule repeats in; an existing rule keeps its own. */
  timezone: string;
  onChange: (rule: string | null) => void;
  className?: string;
  iconClassName?: string;
  iconSize?: number;
  /** Off when the row sits beside another field that leads with its own icon. */
  icon?: boolean;
}) {
  const { t } = useTranslation();
  const [customOpen, setCustomOpen] = useState(false);
  const zone = parseRecurrence(value)?.tzid ?? timezone;
  const presets = useMemo(() => repeatPresets(start, zone), [start, zone]);
  const matched = presets.find((p) => samePattern(p.rule, value));
  const selected = !value ? NONE : matched ? matched.key : CURRENT;

  const onSelect = (key: string) => {
    if (key === CUSTOM) {
      setCustomOpen(true);
      return;
    }
    if (key === NONE) return onChange(null);
    if (key === CURRENT) return;
    const preset = presets.find((p) => p.key === key);
    // A new pattern keeps the end set before ("until", "N times").
    if (preset) onChange(value ? withEnd(preset.rule, value) : preset.rule);
  };

  const label = (rule: string) => {
    const parsed = parseRecurrence(rule);
    return parsed ? describePattern(parsed, start, t) : "";
  };
  const endLabel = describeRecurrence(value, start, t);

  return (
    <div className={className}>
      {icon && (
        <Repeat size={iconSize} className={iconClassName} aria-hidden />
      )}
      <Select value={selected} onValueChange={onSelect}>
        <SelectTrigger
          size="sm"
          className="w-full min-w-0"
          aria-label={t("calendar.repeat.label", "Repeat")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>
            {t("calendar.repeat.none", "Does not repeat")}
          </SelectItem>
          {presets.map((p) => (
            <SelectItem key={p.key} value={p.key}>
              {p.key === selected && endLabel ? endLabel : label(p.rule)}
            </SelectItem>
          ))}
          {selected === CURRENT && value && (
            <SelectItem value={CURRENT}>{endLabel}</SelectItem>
          )}
          <SelectSeparator />
          <SelectItem value={CUSTOM}>
            {t("calendar.repeat.custom", "Custom…")}
          </SelectItem>
        </SelectContent>
      </Select>
      <CustomRepeatDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        initial={value}
        start={start}
        timezone={zone}
        onSave={(rule) => {
          setCustomOpen(false);
          onChange(rule);
        }}
      />
    </div>
  );
}

type EndMode = "never" | "until" | "count";
type MonthlyMode = "day" | "weekday";

const UNITS: RecurrenceFreq[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

function CustomRepeatDialog({
  open,
  onOpenChange,
  initial,
  start,
  timezone,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: string | null;
  start: string;
  timezone: string;
  onSave: (rule: string) => void;
}) {
  const { t } = useTranslation();
  const first = DateTime.fromISO(start).setZone(timezone);
  const firstDay = WEEKDAY_CODES[first.weekday - 1];

  // Seeded from the stored rule each time the dialog opens.
  const [rule, setRule] = useState<RecurrenceRule>(() => seed());
  const [interval, setIntervalText] = useState(String(rule.interval));
  const [countText, setCountText] = useState(String(rule.count ?? 10));
  const [endMode, setEndMode] = useState<EndMode>("never");
  const [until, setUntil] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(false);

  function seed(): RecurrenceRule {
    return (
      parseRecurrence(initial) ?? {
        ...baseRule("WEEKLY", timezone),
        byDay: [{ n: null, day: firstDay }],
      }
    );
  }

  if (open && !wasOpen) {
    const r = seed();
    setRule(r);
    setIntervalText(String(r.interval));
    setCountText(String(r.count ?? 10));
    setEndMode(
      r.count !== null ? "count" : r.until !== null ? "until" : "never",
    );
    setUntil(r.until ?? first.plus({ months: 3 }).toUTC().toISO());
    setWasOpen(true);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const intervalNum = Math.max(1, Math.min(999, Number(interval) || 1));
  const days = new Set(
    rule.byDay.filter((d) => d.n === null).map((d) => d.day),
  );
  const monthlyMode: MonthlyMode = rule.byDay.some((d) => d.n !== null)
    ? "weekday"
    : "day";
  const nth = monthlyOrdinalOf(first, false);
  const ordinal = nth.n > 4 ? monthlyOrdinalOf(first, true) : nth;

  const setFreq = (freq: RecurrenceFreq) => {
    setRule((r) => ({
      ...r,
      freq,
      byDay: freq === "WEEKLY" ? [{ n: null, day: firstDay }] : [],
      byMonthDay: null,
    }));
  };

  const toggleDay = (day: WeekdayCode) => {
    const next = new Set(days);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    // A week with no days left falls back to the start's own day.
    if (next.size === 0) next.add(firstDay);
    setRule((r) => ({
      ...r,
      byDay: WEEKDAY_CODES.filter((d) => next.has(d)).map((d) => ({
        n: null,
        day: d,
      })),
    }));
  };

  const result = (): RecurrenceRule => ({
    ...rule,
    interval: intervalNum,
    count:
      endMode === "count"
        ? Math.max(1, Math.min(999, Number(countText) || 1))
        : null,
    until: endMode === "until" && until ? until : null,
  });

  const unitLabel = (freq: RecurrenceFreq) => {
    const opts = { count: intervalNum };
    switch (freq) {
      case "DAILY":
        return t("calendar.repeat.unit.day", {
          ...opts,
          defaultValue_one: "day",
          defaultValue_other: "days",
        });
      case "WEEKLY":
        return t("calendar.repeat.unit.week", {
          ...opts,
          defaultValue_one: "week",
          defaultValue_other: "weeks",
        });
      case "MONTHLY":
        return t("calendar.repeat.unit.month", {
          ...opts,
          defaultValue_one: "month",
          defaultValue_other: "months",
        });
      case "YEARLY":
        return t("calendar.repeat.unit.year", {
          ...opts,
          defaultValue_one: "year",
          defaultValue_other: "years",
        });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t("calendar.repeat.customTitle", "Custom repeat")}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="shrink-0">
              {t("calendar.repeat.every", "Every")}
            </span>
            <Input
              type="number"
              min={1}
              max={999}
              inputMode="numeric"
              value={interval}
              onChange={(e) => setIntervalText(e.target.value)}
              className="w-20"
              aria-label={t("calendar.repeat.interval", "How often")}
            />
            <Select
              value={rule.freq}
              onValueChange={(v) => setFreq(v as RecurrenceFreq)}
            >
              <SelectTrigger size="sm" className="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNITS.map((u) => (
                  <SelectItem key={u} value={u}>
                    {unitLabel(u)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {rule.freq === "WEEKLY" && (
            <div className="grid gap-2">
              <span>{t("calendar.repeat.onDays", "On")}</span>
              <div className="flex flex-wrap gap-1">
                {WEEKDAY_CODES.map((d) => (
                  <Button
                    key={d}
                    type="button"
                    size="sm"
                    variant={days.has(d) ? "default" : "outline"}
                    aria-pressed={days.has(d)}
                    aria-label={weekdayName(d)}
                    onClick={() => toggleDay(d)}
                    className="min-w-9 px-2"
                  >
                    {weekdayName(d, "short")}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {rule.freq === "MONTHLY" && (
            <Select
              value={monthlyMode}
              onValueChange={(v) =>
                setRule((r) => ({
                  ...r,
                  byDay: v === "weekday" ? [ordinal] : [],
                  byMonthDay: null,
                }))
              }
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">
                  {describePattern(
                    { ...baseRule("MONTHLY", timezone), interval: intervalNum },
                    start,
                    t,
                  )}
                </SelectItem>
                <SelectItem value="weekday">
                  {describePattern(
                    {
                      ...baseRule("MONTHLY", timezone),
                      interval: intervalNum,
                      byDay: [ordinal],
                    },
                    start,
                    t,
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
          )}

          <fieldset className="grid gap-2">
            <legend className="mb-2">
              {t("calendar.repeat.ends", "Ends")}
            </legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="repeat-end"
                checked={endMode === "never"}
                onChange={() => setEndMode("never")}
              />
              {t("calendar.repeat.endsNever", "Never")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="repeat-end"
                checked={endMode === "until"}
                onChange={() => setEndMode("until")}
              />
              <span className="shrink-0">
                {t("calendar.repeat.endsOn", "On")}
              </span>
              <div className="flex-1">
                <DateTimePicker
                  type="date"
                  value={until}
                  timezone={timezone}
                  size="small"
                  fullWidth
                  onChange={(picked) => {
                    if (!picked) return;
                    setEndMode("until");
                    setUntil(
                      DateTime.fromISO(picked, { zone: timezone })
                        .endOf("day")
                        .toUTC()
                        .toISO({ suppressMilliseconds: true }),
                    );
                  }}
                />
              </div>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="repeat-end"
                checked={endMode === "count"}
                onChange={() => setEndMode("count")}
              />
              <span className="shrink-0">
                {t("calendar.repeat.endsAfter", "After")}
              </span>
              <Input
                type="number"
                min={1}
                max={999}
                inputMode="numeric"
                value={countText}
                onFocus={() => setEndMode("count")}
                onChange={(e) => setCountText(e.target.value)}
                className="w-20"
                aria-label={t(
                  "calendar.repeat.occurrenceCount",
                  "Number of times",
                )}
              />
              <span>
                {t("calendar.repeat.times", {
                  count: Math.max(1, Number(countText) || 1),
                  defaultValue_one: "time",
                  defaultValue_other: "times",
                })}
              </span>
            </label>
          </fieldset>

          <p className="text-muted-foreground">
            {describeRecurrence(formatRecurrence(result()), start, t)}
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button size="sm" onClick={() => onSave(formatRecurrence(result()))}>
            {t("common.done", "Done")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
