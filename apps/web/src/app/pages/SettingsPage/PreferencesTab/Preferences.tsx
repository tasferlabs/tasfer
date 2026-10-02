import { Keyboard } from "lucide-react";
import { useTranslation } from "react-i18next";
import useMobileLayout from "@/app/hooks/useMobileLayout";
import { Button } from "@/components/ui/button";
import { useShortcutsDialog } from "@/shortcuts/ShortcutsContext";
import { Section } from "../shared/Section";
import styles from "./Preferences.module.css";
import {
  DisplayDensity,
  LanguageSelect,
  ThemeSelect,
} from "./AppearanceSettings";

export function Preferences() {
  const { isMobile } = useMobileLayout();
  return (
    <div className={styles.container}>
      <LanguageSelect />
      <DisplayDensity />
      <ThemeSelect />
      {/* The layout mounts the dialog under the same rule. */}
      {!isMobile && <KeyboardShortcuts />}
    </div>
  );
}

function KeyboardShortcuts() {
  const { t } = useTranslation();
  const { setOpen } = useShortcutsDialog();
  return (
    <Section
      title={t("shortcuts.title", "Keyboard shortcuts")}
      description={t(
        "shortcuts.settingsDescription",
        "See every shortcut in one list, and change the ones you use.",
      )}
    >
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Keyboard />
        {t("shortcuts.open", "Open shortcuts")}
      </Button>
    </Section>
  );
}
