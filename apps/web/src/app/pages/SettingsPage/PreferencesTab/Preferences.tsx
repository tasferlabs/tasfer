import { useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./Preferences.module.css";
import {
  DisplayDensity,
  LanguageSelect,
  ThemeSelect,
  Section,
} from "./AppearanceSettings";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getTimeFormat,
  setTimeFormat,
  getDateFormat,
  setDateFormat,
  getWeekStart,
  setWeekStart,
  type TimeFormat,
  type DateFormat,
  type WeekStart,
} from "@/lib/dateTimePreferences";

export function Preferences() {
  const { t, i18n } = useTranslation();
  const [timeFormat, setTimeFormatState] = useState<TimeFormat>(getTimeFormat);
  const [dateFormat, setDateFormatState] = useState<DateFormat>(getDateFormat);
  const [weekStartDay, setWeekStartState] = useState<WeekStart>(getWeekStart);

  function onChangeTimeFormat(value: TimeFormat) {
    setTimeFormat(value);
    setTimeFormatState(value);
  }

  function onChangeDateFormat(value: DateFormat) {
    setDateFormat(value);
    setDateFormatState(value);
  }

  function onChangeWeekStart(value: string) {
    const day = Number(value) as WeekStart;
    setWeekStart(day);
    setWeekStartState(day);
  }

  return (
    <div className={styles.container}>
      <LanguageSelect />
      <DisplayDensity />
      <ThemeSelect />

      <Section
        title={t("settings.dateTime.title", "Date & Time")}
        description={t(
          "settings.dateTime.description",
          "How dates and times read throughout the app. Set once — timestamps, calendars, and the week's first day all follow.",
        )}
      >
        <div className={styles.row}>
          <div className={styles.column}>
            <p className={cn("text-sm", styles.title)}>
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
            <SelectTrigger className={styles.selectTrigger}>
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

        <div className={styles.row}>
          <div className={styles.column}>
            <p className={cn("text-sm", styles.title)}>
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
            <SelectTrigger className={styles.selectTrigger}>
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

        <div className={styles.row}>
          <div className={styles.column}>
            <p className={cn("text-sm", styles.title)}>
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
            <SelectTrigger className={styles.selectTrigger}>
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
