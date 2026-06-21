import { useTranslation } from "react-i18next";
import styles from "./Information.module.css";

export function Information() {
  const { t } = useTranslation();

  return (
    <div className={styles.container}>
      <div className="text-xs text-muted-foreground mt-auto pt-8 space-y-1">
        <p>
          {t("common.version", "Version")}: {__BUILD_TIMESTAMP__}
        </p>
        <p>
          {t(
            "settings.information.license",
            "Cypher is free software, licensed under the GNU AGPL-3.0.",
          )}{" "}
          <a
            href="https://github.com/hamza512b/cypher"
            target="_blank"
            rel="noreferrer noopener"
            className="underline"
          >
            {t("settings.information.viewSource", "View source code")}
          </a>
        </p>
        <p>
          <a
            href={`${import.meta.env.BASE_URL}THIRD-PARTY-LICENSES.txt`}
            target="_blank"
            rel="noreferrer noopener"
            className="underline"
          >
            {t("settings.information.thirdPartyLicenses", "Third-party licenses")}
          </a>
        </p>
      </div>
    </div>
  );
}
