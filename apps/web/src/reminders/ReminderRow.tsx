import { Bell } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOwnPref } from "@/app/contexts/OwnPrefsContext";
import { useReminders } from "./RemindersContext";
import {
  DEFAULT_REMINDER_KEY,
  REMINDER_CHOICES,
  effectiveReminder,
  parseReminderSetting,
  reminderChoiceLabel,
  reminderPrefKey,
  type ReminderSetting,
} from "./reminders";
import styles from "./reminders.module.css";

/** A select's string value for a setting, and back. */
export function settingToValue(setting: ReminderSetting): string {
  return setting === "off" ? "off" : String(setting);
}

export function valueToSetting(value: string): ReminderSetting | undefined {
  return parseReminderSetting(value === "off" ? "off" : Number(value));
}

/** The menu choices, plus `current` if another build stored one we don't offer. */
export function choicesWith(current: ReminderSetting): ReminderSetting[] {
  if (REMINDER_CHOICES.includes(current)) return [...REMINDER_CHOICES];
  return [...REMINDER_CHOICES, current].sort((a, b) =>
    a === "off" ? -1 : b === "off" ? 1 : a - b,
  );
}

/**
 * The "Remind me" row of an event's panel. What it writes is this person's
 * alone (see `./reminders`): changing it never touches the shared event.
 */
export function ReminderRow({
  ownerId,
  allDay,
  ...look
}: {
  /** The event — or for a repeating one, its series (see `reminderOwner`). */
  ownerId: string;
  allDay: boolean;
} & RowLook) {
  const own = useOwnPref<unknown>(reminderPrefKey(ownerId), undefined);
  const fallback = useOwnPref<unknown>(DEFAULT_REMINDER_KEY, undefined);
  const setting = effectiveReminder({ allDay }, own.value, fallback.value);
  return <ReminderField setting={setting} onPick={own.set} {...look} />;
}

/**
 * The same row for an event not saved yet: there is no id to store the pick
 * under, so the panel holds it (`chosen`, `undefined` while the default
 * applies) and stores it once the event exists.
 */
export function DraftReminderRow({
  chosen,
  onChosenChange,
  allDay,
  ...look
}: {
  chosen: ReminderSetting | undefined;
  onChosenChange: (next: ReminderSetting) => void;
  allDay: boolean;
} & RowLook) {
  const fallback = useOwnPref<unknown>(DEFAULT_REMINDER_KEY, undefined);
  const setting = effectiveReminder({ allDay }, chosen, fallback.value);
  return <ReminderField setting={setting} onPick={onChosenChange} {...look} />;
}

interface RowLook {
  className?: string;
  iconClassName?: string;
  iconSize?: number;
}

function ReminderField({
  setting,
  onPick,
  className,
  iconClassName,
  iconSize = 14,
}: {
  setting: ReminderSetting;
  onPick: (next: ReminderSetting) => void;
} & RowLook) {
  const { t } = useTranslation();
  const { permission, requestPermission } = useReminders();

  const onChange = (value: string) => {
    const next = valueToSetting(value);
    if (next === undefined) return;
    onPick(next);
    // Asked here, from the person's own pick, rather than at launch: it is the
    // moment the question makes sense, and browsers only prompt from a gesture.
    if (next !== "off" && permission === "prompt") void requestPermission();
  };

  let hint: React.ReactNode = null;
  if (setting !== "off" && permission === "prompt") {
    hint = (
      <button
        type="button"
        className={styles.hintAction}
        onClick={() => void requestPermission()}
      >
        {t("reminders.allowOnDevice", "Allow notifications on this device")}
      </button>
    );
  } else if (setting !== "off" && permission === "denied") {
    hint = (
      <span className={styles.hint}>
        {t(
          "reminders.blockedOnDevice",
          "Notifications are blocked on this device",
        )}
      </span>
    );
  }

  return (
    <div className={className}>
      <Bell size={iconSize} className={iconClassName} aria-hidden />
      <div className={styles.rowBody}>
        <Select value={settingToValue(setting)} onValueChange={onChange}>
          <SelectTrigger
            size="sm"
            className="w-full"
            aria-label={t("reminders.label", "Reminder")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choicesWith(setting).map((choice) => (
              <SelectItem key={String(choice)} value={settingToValue(choice)}>
                {reminderChoiceLabel(choice, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hint}
      </div>
    </div>
  );
}
