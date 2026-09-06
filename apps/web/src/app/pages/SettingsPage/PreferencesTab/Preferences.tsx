import styles from "./Preferences.module.css";
import {
  DisplayDensity,
  LanguageSelect,
  ThemeSelect,
} from "./AppearanceSettings";

export function Preferences() {
  return (
    <div className={styles.container}>
      <LanguageSelect />
      <DisplayDensity />
      <ThemeSelect />
    </div>
  );
}
