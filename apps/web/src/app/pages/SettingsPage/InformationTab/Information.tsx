import { useTranslation } from "react-i18next";
import styles from "./Information.module.css";

export function Information() {
  const { t } = useTranslation();

  return (
    <div className={styles.container}>
      <p className="text-xs text-muted-foreground mt-auto pt-8">
        {t("common.version", "Version")}: {__BUILD_TIMESTAMP__}
      </p>
    </div>
  );
}
