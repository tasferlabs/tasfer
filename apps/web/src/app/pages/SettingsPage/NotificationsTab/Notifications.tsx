import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOwnPref } from "@/app/contexts/OwnPrefsContext";
import { cn } from "@/lib/utils";
import { getClientPlatform } from "@/platform";
import {
  exactTimingPermission,
  openExactTimingSettings,
  type NotifyPermission,
} from "@/reminders/delivery";
import {
  DEFAULT_REMINDER_KEY,
  FALLBACK_DEFAULT_REMINDER,
  parseReminderSetting,
  reminderChoiceLabel,
} from "@/reminders/reminders";
import {
  choicesWith,
  settingToValue,
  valueToSetting,
} from "@/reminders/ReminderRow";
import { useReminders } from "@/reminders/RemindersContext";
import { Section } from "../shared/Section";
import rows from "../shared/rows.module.css";
import styles from "./Notifications.module.css";

export function Notifications() {
  const { t } = useTranslation();
  const { permission, requestPermission } = useReminders();
  const stored = useOwnPref<unknown>(DEFAULT_REMINDER_KEY, undefined);
  const defaultSetting =
    parseReminderSetting(stored.value) ?? FALLBACK_DEFAULT_REMINDER;

  const platform = getClientPlatform();
  const [exact, setExact] = useState<NotifyPermission | null>(null);
  useEffect(() => {
    let cancelled = false;
    void exactTimingPermission().then((p) => {
      if (!cancelled) setExact(p);
    });
    return () => {
      cancelled = true;
    };
  }, [permission]);

  let deviceStatus: React.ReactNode;
  if (permission === "granted") {
    deviceStatus = (
      <span className="text-sm">{t("reminders.settings.on", "On")}</span>
    );
  } else if (permission === "prompt") {
    deviceStatus = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => void requestPermission()}
      >
        {t("reminders.settings.allow", "Allow")}
      </Button>
    );
  } else if (permission === "denied") {
    deviceStatus = (
      <span className="text-sm opacity-75">
        {t("reminders.settings.blocked", "Blocked")}
      </span>
    );
  } else {
    deviceStatus = (
      <span className="text-sm opacity-75">
        {t("reminders.settings.unsupported", "Not available")}
      </span>
    );
  }

  let deviceDescription: string;
  if (permission === "denied") {
    deviceDescription =
      platform === "web"
        ? t(
            "reminders.settings.blockedWeb",
            "Your browser is blocking notifications from Tasfer. Allow them in the site settings, then come back.",
          )
        : t(
            "reminders.settings.blockedNative",
            "Notifications for Tasfer are turned off in your system settings.",
          );
  } else if (platform === "web") {
    // No server can wake a closed tab: reminders are timed inside the page.
    deviceDescription = t(
      "reminders.settings.webOnlyWhileOpen",
      "In a browser, reminders arrive only while Tasfer is open in a tab. The desktop and mobile apps remind you even when closed.",
    );
  } else {
    deviceDescription = t(
      "reminders.settings.deviceDescription",
      "Whether this device can show your reminders.",
    );
  }

  return (
    <div className={styles.container}>
      <Section
        title={t("reminders.settings.title", "Notifications")}
        description={t(
          "reminders.settings.description",
          "Reminders for events on your calendar. They're yours alone: setting one never notifies anyone else in the space, and it follows you to all your devices.",
        )}
      >
        <div className={rows.row}>
          <div>
            <p className={cn("text-sm", rows.title)}>
              {t("reminders.settings.default", "Default reminder")}
            </p>
            <p className="text-sm opacity-75">
              {t(
                "reminders.settings.defaultDescription",
                "For events you haven't set a reminder on. All-day events stay silent unless you set one.",
              )}
            </p>
          </div>
          <Select
            value={settingToValue(defaultSetting)}
            onValueChange={(value) => {
              const next = valueToSetting(value);
              if (next !== undefined) stored.set(next);
            }}
          >
            <SelectTrigger className={rows.selectTrigger}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choicesWith(defaultSetting).map((choice) => (
                <SelectItem key={String(choice)} value={settingToValue(choice)}>
                  {reminderChoiceLabel(choice, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className={rows.row}>
          <div>
            <p className={cn("text-sm", rows.title)}>
              {t("reminders.settings.device", "On this device")}
            </p>
            <p className="text-sm opacity-75">{deviceDescription}</p>
          </div>
          <div className={styles.control}>{deviceStatus}</div>
        </div>

        {exact === "denied" && permission === "granted" && (
          <div className={rows.row}>
            <div>
              <p className={cn("text-sm", rows.title)}>
                {t("reminders.settings.exact", "On-time reminders")}
              </p>
              <p className="text-sm opacity-75">
                {t(
                  "reminders.settings.exactDescription",
                  "Android may deliver reminders a few minutes late until Tasfer is allowed to set alarms and reminders.",
                )}
              </p>
            </div>
            <div className={styles.control}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() =>
                  void openExactTimingSettings().then((p) => setExact(p))
                }
              >
                {t("reminders.settings.allow", "Allow")}
              </Button>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
