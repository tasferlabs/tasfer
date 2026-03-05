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

export function Preferences() {
  const { getConfirmation } = useConfirmation();
  const { t, i18n } = useTranslation("SettingsPage");
  const theme = useTheme();

  function onChangeTheme(themeValue: Theme) {
    theme.setTheme(themeValue);
  }

  async function onChangeLangaue(_language: string) {
    const confirmed = await getConfirmation({
      title: t`Are you sure?`,
      description: t`Changing the language will reload the page.`,
    });

    if (!confirmed) return;

    // i18n.changeLanguage(language);
    // setCookie("locale", language, 365);
    window.location.reload();
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
          </SelectContent>
        </Select>
      </div>

      <p className="text-xs text-muted-foreground mt-auto pt-8">
        {t`Version`}: {__BUILD_TIMESTAMP__}
      </p>
    </div>
  );
}
