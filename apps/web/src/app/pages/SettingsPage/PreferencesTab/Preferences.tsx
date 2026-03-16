import { useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./Preferences.module.css";
import { useTheme, type Theme } from "@/app/hooks/useTheme";
import { useConfirmation } from "@/app/components/ConfirmationDialog";
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
  const { getConfirmation } = useConfirmation();
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const [timeFormat, setTimeFormatState] = useState<TimeFormat>(getTimeFormat);
  const [dateFormat, setDateFormatState] = useState<DateFormat>(getDateFormat);
  const [weekStartDay, setWeekStartState] = useState<WeekStart>(getWeekStart);

  function onChangeTheme(themeValue: Theme) {
    theme.setTheme(themeValue);
  }

  async function onChangeLangaue(language: string) {
    const confirmed = await getConfirmation({
      title: t`Are you sure?`,
      description: t`Changing the language will reload the page.`,
    });

    if (!confirmed) return;

    document.cookie = `locale=${language};path=/;max-age=${365 * 24 * 60 * 60}`;
    i18n.changeLanguage(language);
    window.location.reload();
  }

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
      <div className={styles.row}>
        <div className={styles.column}>
          <p className={cn("text-sm", styles.title)}>{t`Theme`}</p>
          <p className="text-sm opacity-75">{t`Select theme for the application`}</p>
        </div>

        <Select onValueChange={onChangeTheme} value={theme.theme}>
          <SelectTrigger className={styles.selectTrigger}>
            <SelectValue placeholder={t`Select theme`} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">{t`Light`}</SelectItem>
            <SelectItem value="dark">{t`Dark`}</SelectItem>
            <SelectItem value="system">{t`System`}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className={styles.row}>
        <div className={styles.column}>
          <p className={cn("text-sm", styles.title)}>{t`Language`}</p>
          <p className="text-sm opacity-75">{t`Select language for the application`}</p>
        </div>
        <Select onValueChange={onChangeLangaue} value={i18n.language}>
          <SelectTrigger className={styles.selectTrigger}>
            <SelectValue placeholder={t`Select language`} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="ar">العربية</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className={styles.row}>
        <div className={styles.column}>
          <p className={cn("text-sm", styles.title)}>{t`Time format`}</p>
          <p className="text-sm opacity-75">{t`Choose how times are displayed`}</p>
        </div>
        <Select onValueChange={onChangeTimeFormat} value={timeFormat}>
          <SelectTrigger className={styles.selectTrigger}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{t`System default`}</SelectItem>
            <SelectItem value="12h">{t`12-hour`} ({new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(2000, 0, 1, 14, 30))})</SelectItem>
            <SelectItem value="24h">{t`24-hour`} (14:30)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className={styles.row}>
        <div className={styles.column}>
          <p className={cn("text-sm", styles.title)}>{t`Date format`}</p>
          <p className="text-sm opacity-75">{t`Choose how dates are displayed`}</p>
        </div>
        <Select onValueChange={onChangeDateFormat} value={dateFormat}>
          <SelectTrigger className={styles.selectTrigger}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{t`System default`}</SelectItem>
            <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
            <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
            <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className={styles.row}>
        <div className={styles.column}>
          <p className={cn("text-sm", styles.title)}>{t`Week starts on`}</p>
          <p className="text-sm opacity-75">{t`Choose which day the week begins`}</p>
        </div>
        <Select onValueChange={onChangeWeekStart} value={String(weekStartDay)}>
          <SelectTrigger className={styles.selectTrigger}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">{t`Monday`}</SelectItem>
            <SelectItem value="0">{t`Sunday`}</SelectItem>
            <SelectItem value="6">{t`Saturday`}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
