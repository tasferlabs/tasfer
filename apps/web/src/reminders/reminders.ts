import { DateTime } from "luxon";
import type { TFunction } from "i18next";

/**
 * Event reminders: what a person asked to be reminded of, and when.
 *
 * A reminder belongs to the person, not to the event. The event is shared with
 * everyone in its space; the reminder lives in the person-private preference
 * register (see `OwnPrefsContext`), so it follows them to each of their devices
 * and never reaches a co-member. Every device plans the same reminders from the
 * same events and preferences, and each one delivers them on its own screen.
 *
 * Nothing here talks to a platform — see `./delivery` for that.
 */

/** Minutes before the start, or `"off"` for no reminder. */
export type ReminderSetting = number | "off";

/**
 * Key PREFIX: `reminder.<pageId>` → the {@link ReminderSetting} chosen for that
 * event. Absent (or `null`, which puts it back) means the event follows
 * {@link DEFAULT_REMINDER_KEY}. One key per event because the register is
 * last-writer-wins per key: two devices changing two events never collide.
 * Mirrored as `OWN_PREF_KEYS.reminderPrefix`.
 */
export const REMINDER_PREF_PREFIX = "reminder.";

/**
 * `ReminderSetting` — the reminder a timed event gets until one is chosen for
 * it. Absent means {@link FALLBACK_DEFAULT_REMINDER}. Mirrored as
 * `OWN_PREF_KEYS.reminderDefault`.
 */
export const DEFAULT_REMINDER_KEY = "reminders.default";

export const FALLBACK_DEFAULT_REMINDER: ReminderSetting = 10;

/** The choices offered everywhere a reminder is picked, in menu order. */
export const REMINDER_CHOICES: readonly ReminderSetting[] = [
  "off",
  0,
  5,
  10,
  15,
  30,
  60,
  120,
  1440,
];

/**
 * An all-day event has no start time, so its reminder counts back from this
 * hour of its day — "at start" is 09:00, "1 day before" is 09:00 the day before.
 */
export const ALL_DAY_REMINDER_HOUR = 9;

/**
 * How far ahead reminders are planned. Phones hand the plan to the OS, which
 * keeps firing while the app is closed, so this is also how long a phone can go
 * unopened before reminders stop. iOS holds at most 64 pending notifications;
 * {@link MAX_PLANNED} stays under that.
 */
export const PLAN_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_PLANNED = 60;

export function reminderPrefKey(pageId: string): string {
  return `${REMINDER_PREF_PREFIX}${pageId}`;
}

/** A stored value read back, or `undefined` if it is not one this build knows. */
export function parseReminderSetting(
  value: unknown,
): ReminderSetting | undefined {
  if (value === "off") return "off";
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return undefined;
}

/** The fields of a calendar entry a reminder needs. */
export interface ReminderEvent {
  /** The calendar entry — for a repeating event, one occurrence. */
  id: string;
  title: string;
  scheduledAt: string;
  allDay?: boolean | null;
  /** Set on an occurrence of a repeating event: the series page. */
  seriesId?: string | null;
  /** A task that was ticked off; it no longer reminds. */
  done?: boolean;
}

/**
 * The page whose reminder setting an entry follows. A repeating event's
 * reminder is set once, on the series, and applies to every occurrence.
 */
export function reminderOwner(
  event: Pick<ReminderEvent, "id" | "seriesId">,
): string {
  return event.seriesId ?? event.id;
}

/**
 * The reminder that applies to `event`: the one chosen for it, or else the
 * default. All-day events only remind when asked — the default is about timed
 * events, and a 08:50 nudge for every all-day entry would be noise.
 */
export function effectiveReminder(
  event: Pick<ReminderEvent, "allDay">,
  chosen: unknown,
  defaultSetting: unknown,
): ReminderSetting {
  const own = parseReminderSetting(chosen);
  if (own !== undefined) return own;
  if (event.allDay) return "off";
  return parseReminderSetting(defaultSetting) ?? FALLBACK_DEFAULT_REMINDER;
}

/** One reminder due to fire. */
export interface PlannedReminder {
  /** Stable per entry and fire time, so re-planning recognises it. */
  key: string;
  /** The calendar entry it is about (see {@link ReminderEvent.id}). */
  entryId: string;
  title: string;
  /** Unix ms the reminder fires. */
  fireAt: number;
  /** The event's start as stored (an ISO instant). */
  scheduledAt: string;
  minutesBefore: number;
  allDay: boolean;
}

/** The moment an event's reminder counts back from. */
export function reminderBase(event: ReminderEvent, timezone: string): number {
  const start = DateTime.fromISO(event.scheduledAt);
  if (!event.allDay) return start.toMillis();
  // The same reading of the day the grid uses (`zonedWallDate`): the stored
  // instant seen in the display zone.
  return start
    .setZone(timezone)
    .startOf("day")
    .set({ hour: ALL_DAY_REMINDER_HOUR })
    .toMillis();
}

/**
 * Every reminder due after `after` and within the planning horizon, soonest
 * first. Pure: the same events, preferences and clock give the same plan on
 * every device.
 */
export function planReminders(
  events: readonly ReminderEvent[],
  /** The stored setting for a {@link reminderOwner}. */
  chosenFor: (ownerId: string) => unknown,
  defaultSetting: unknown,
  after: number,
  timezone: string,
): PlannedReminder[] {
  const until = after + PLAN_HORIZON_MS;
  const planned: PlannedReminder[] = [];
  for (const event of events) {
    if (event.done) continue;
    const setting = effectiveReminder(
      event,
      chosenFor(reminderOwner(event)),
      defaultSetting,
    );
    if (setting === "off") continue;
    const base = reminderBase(event, timezone);
    if (!Number.isFinite(base)) continue;
    const fireAt = base - setting * 60_000;
    if (fireAt <= after || fireAt > until) continue;
    planned.push({
      key: `${event.id}@${fireAt}`,
      entryId: event.id,
      title: event.title,
      fireAt,
      scheduledAt: event.scheduledAt,
      minutesBefore: setting,
      allDay: Boolean(event.allDay),
    });
  }
  planned.sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key));
  return planned.slice(0, MAX_PLANNED);
}

/** The menu label for a choice: "None", "At start", "10 min before", … */
export function reminderChoiceLabel(
  setting: ReminderSetting,
  t: TFunction,
): string {
  if (setting === "off") return t("reminders.choice.off", "None");
  if (setting === 0) return t("reminders.choice.atStart", "At start");
  if (setting % 1440 === 0) {
    return t("reminders.choice.daysBefore", {
      defaultValue: "{{count}} day before",
      count: setting / 1440,
    });
  }
  if (setting % 60 === 0) {
    return t("reminders.choice.hoursBefore", {
      defaultValue: "{{count}} hr before",
      count: setting / 60,
    });
  }
  return t("reminders.choice.minutesBefore", {
    defaultValue: "{{count}} min before",
    count: setting,
  });
}

/** The text a delivered reminder shows: its title, and when the event starts. */
export function reminderMessage(
  reminder: PlannedReminder,
  t: TFunction,
  timezone: string,
  hour12: boolean | undefined,
  language: string,
): { title: string; body: string } {
  const title = reminder.title.trim() || t("common.untitled", "Untitled");
  const start = new Date(reminder.scheduledAt);
  let body: string;
  if (reminder.allDay) {
    // Escaping off: the text goes to a notification, not to HTML, and an
    // escaped "/" in a numeric date would print as an entity.
    body = t("reminders.allDay", {
      defaultValue: "All day, {{date}}",
      interpolation: { escapeValue: false },
      date: start.toLocaleDateString(language, {
        timeZone: timezone,
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    });
  } else if (reminder.minutesBefore === 0) {
    body = t("reminders.startsNow", "Starting now");
  } else {
    // The start time, not "in 10 minutes": a reminder can land late (a laptop
    // waking up, a throttled tab), and a clock time stays true when it does.
    body = t("reminders.startsAt", {
      defaultValue: "Starts at {{time}}",
      interpolation: { escapeValue: false },
      time: start.toLocaleTimeString(language, {
        timeZone: timezone,
        hour: "numeric",
        minute: "2-digit",
        hour12,
      }),
    });
  }
  return { title, body };
}

/** Where opening a reminder lands: the entry, open on its day in the calendar. */
export function reminderRoute(entryId: string, scheduledAt: string): string {
  const params = new URLSearchParams({ event: entryId, at: scheduledAt });
  return `/calendar?${params.toString()}`;
}
