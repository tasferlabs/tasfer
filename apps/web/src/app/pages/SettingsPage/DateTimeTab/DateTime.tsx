import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TimezonePicker } from "@/components/timezonepicker/TimezonePicker";
import {
  type TimeFormat,
  type DateFormat,
  type WeekStart,
  type TimezonePreference,
} from "@/lib/dateTimePreferences";
import { useDateTimePref } from "@/app/contexts/DateTimePrefsContext";
import { cn } from "@/lib/utils";
import { Section } from "../shared/Section";
import rows from "../shared/rows.module.css";
import styles from "./DateTime.module.css";

export function DateTime() {
  const { t, i18n } = useTranslation();
  // Every choice here is written to this person's preference register, so it
  // reaches their other devices; the controls follow it back when one of those
  // devices is where the change was made.
  const { value: timeFormat, set: setTimeFormat } =
    useDateTimePref("timeFormat");
  const { value: dateFormat, set: setDateFormat } =
    useDateTimePref("dateFormat");
  const { value: weekStartDay, set: setWeekStart } =
    useDateTimePref("weekStart");
  const { value: timezone, set: setTimezone } = useDateTimePref("timezone");
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // The selects hand back the raw option value; each list is closed and written
  // out below, so the cast is over the same set of strings.
  function onChangeTimeFormat(value: string) {
    setTimeFormat(value as TimeFormat);
  }

  function onChangeDateFormat(value: string) {
    setDateFormat(value as DateFormat);
  }

  function onChangeWeekStart(value: string) {
    setWeekStart(Number(value) as WeekStart);
  }

  function onChangeTimezone(zone: TimezonePreference) {
    setTimezone(zone);
  }

  return (
    <div className={styles.container}>
      <Section
        title={t("settings.dateTime.title", "Date & Time")}
        description={t(
          "settings.dateTime.description",
          "How dates and times read throughout the app. Set once — timestamps, calendars, and the week's first day all follow.",
        )}
      >
        <div className={rows.row}>
          <div>
            <p className={cn("text-sm", rows.title)}>
              {t("settings.dateTime.timeFormat", "Time format")}
            </p>
            <p className="text-sm opacity-75">
              {t(
                "settings.dateTime.chooseTimeFormat",
                "Choose how times are displayed",
              )}
            </p>
          </div>
          <Select onValueChange={onChangeTimeFormat} value={timeFormat}>
            <SelectTrigger className={rows.selectTrigger}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">
                {t("settings.theme.systemDefault", "System default")}
              </SelectItem>
              <SelectItem value="12h">
                {t("settings.dateTime.12hour", "12-hour")} (
                {new Intl.DateTimeFormat(i18n.language, {
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                }).format(new Date(2000, 0, 1, 14, 30))}
                )
              </SelectItem>
              <SelectItem value="24h">
                {t("settings.dateTime.24hour", "24-hour")} (14:30)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className={rows.row}>
          <div>
            <p className={cn("text-sm", rows.title)}>
              {t("settings.dateTime.dateFormat", "Date format")}
            </p>
            <p className="text-sm opacity-75">
              {t(
                "settings.dateTime.chooseDateFormat",
                "Choose how dates are displayed",
              )}
            </p>
          </div>
          <Select onValueChange={onChangeDateFormat} value={dateFormat}>
            <SelectTrigger className={rows.selectTrigger}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">
                {t("settings.theme.systemDefault", "System default")}
              </SelectItem>
              <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
              <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
              <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className={rows.row}>
          <div>
            <p className={cn("text-sm", rows.title)}>
              {t("settings.dateTime.timezone", "Time zone")}
            </p>
            <p className="text-sm opacity-75">
              {t(
                "settings.dateTime.chooseTimezone",
                "Choose the time zone dates and times are shown in",
              )}
            </p>
          </div>
          <div className={styles.timezoneControl}>
            {/* Following the device is the most likely pick, so it is the first
                row of the picker's own list rather than a link beside it — as a
                link it was the smallest touch target in the row. */}
            <TimezonePicker
              value={timezone === "system" ? deviceTimezone : timezone}
              onChange={onChangeTimezone}
              isSystem={timezone === "system"}
              onUseSystem={() => onChangeTimezone("system")}
            />
          </div>
        </div>

        <div className={rows.row}>
          <div>
            <p className={cn("text-sm", rows.title)}>
              {t("settings.dateTime.weekStartsOn", "Week starts on")}
            </p>
            <p className="text-sm opacity-75">
              {t(
                "settings.dateTime.chooseWeekStart",
                "Choose which day the week begins",
              )}
            </p>
          </div>
          <Select
            onValueChange={onChangeWeekStart}
            value={String(weekStartDay)}
          >
            <SelectTrigger className={rows.selectTrigger}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">
                {t("settings.dateTime.monday", "Monday")}
              </SelectItem>
              <SelectItem value="0">
                {t("settings.dateTime.sunday", "Sunday")}
              </SelectItem>
              <SelectItem value="6">
                {t("settings.dateTime.saturday", "Saturday")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Section>
    </div>
  );
}
