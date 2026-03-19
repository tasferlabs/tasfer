import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import styles from "./Information.module.css";

export function Information() {
  const { t } = useTranslation();

  return (
    <div className={styles.container}>
      <a
        href="https://cypher.md/privacy"
        target="_blank"
        rel="noopener noreferrer"
        className={styles.link}
      >
        <span className="text-sm">{t("settings.privacyPolicy", "Privacy Policy")}</span>
        <ExternalLink size={16} className={styles.linkIcon} />
      </a>

      <a
        href="https://cypher.md/terms"
        target="_blank"
        rel="noopener noreferrer"
        className={styles.link}
      >
        <span className="text-sm">{t("settings.termsOfService", "Terms of Service")}</span>
        <ExternalLink size={16} className={styles.linkIcon} />
      </a>

      <p className="text-xs text-muted-foreground mt-auto pt-8">
        {t("common.version", "Version")}: {__BUILD_TIMESTAMP__}
      </p>
    </div>
  );
}
