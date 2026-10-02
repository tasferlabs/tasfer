import { Check, Copy, Github } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import useResponsive from "@/app/hooks/useResponsive";
import { Button } from "@/components/ui/button";
import { RelativeDate } from "@/components/ui/relative-date";
import {
  clearErrorLog,
  ERROR_LOG_RETENTION_DAYS,
  getErrorLog,
  subscribeErrorLog,
  type ErrorLogEntry,
} from "@/lib/errorLog";
import {
  buildErrorLogDiagnostics,
  buildErrorLogIssueUrl,
} from "@/lib/reportIssue";
import { cn } from "@/lib/utils";
import { Section } from "../shared/Section";
import rows from "../shared/rows.module.css";
import styles from "./ErrorLog.module.css";

const COPIED_MS = 2000;

function ErrorLogItem({ entry }: { entry: ErrorLogEntry }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildErrorLogDiagnostics(entry));
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // Clipboard unavailable (insecure context / denied) — nothing to do.
    }
  };

  const issueUrl = buildErrorLogIssueUrl(
    entry,
    t(
      "error.boundary.issueIntro",
      "Describe what you were doing when this happened:",
    ),
  );

  return (
    <li className={styles.item}>
      <div className={styles.itemHeader}>
        {/* Error names and messages are code-side text, so they stay LTR. */}
        <span dir="ltr" className={styles.name}>
          {entry.name}
        </span>
        {entry.count > 1 && (
          <span className={styles.count}>
            {t("settings.errorLog.occurrences", {
              count: entry.count,
              defaultValue: "{{count, number}} times",
            })}
          </span>
        )}
        <RelativeDate date={new Date(entry.lastSeen)} className={styles.time} />
      </div>
      <p dir="ltr" className={styles.message}>
        {entry.message}
      </p>
      {entry.stack && (
        <details className={styles.details}>
          <summary className={styles.summary}>
            {t("settings.errorLog.stackTrace", "Stack trace")}
          </summary>
          <pre dir="ltr" className={styles.stack}>
            {entry.stack}
          </pre>
        </details>
      )}
      <div className={styles.actions}>
        <Button variant="ghost" size="xs" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied
            ? t("common.copied", "Copied")
            : t("error.boundary.copyDetails", "Copy details")}
        </Button>
        <Button variant="ghost" size="xs" asChild>
          <a href={issueUrl} target="_blank" rel="noreferrer noopener">
            <Github />
            {t("error.boundary.reportIssue", "Report issue")}
          </a>
        </Button>
      </div>
    </li>
  );
}

export function ErrorLog() {
  const { t } = useTranslation();
  const entries = useSyncExternalStore(subscribeErrorLog, getErrorLog);
  // Matches the breakpoint where Settings becomes a list of bottom sheets.
  const isMobile = useResponsive("(max-width: 640px)");

  return (
    <div className={styles.container}>
      <Section
        className={styles.section}
        // On a phone the sheet's header already says "Error log".
        title={isMobile ? undefined : t("settings.errorLog.title", "Error log")}
        description={t("settings.errorLog.description", {
          count: ERROR_LOG_RETENTION_DAYS,
          defaultValue:
            "Errors the app ran into on this device, kept for {{count, number}} days. They stay only here, and nothing is sent anywhere unless you report one.",
        })}
      >
        {!isMobile && (
          <div className={rows.row}>
            <div>
              <p className={cn("text-sm", rows.title)}>
                {t("settings.errorLog.clearAll", "Clear all")}
              </p>
              <p className="text-sm opacity-75">
                {t(
                  "settings.errorLog.clearAllDescription",
                  "Delete every error saved on this device",
                )}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={clearErrorLog}
              disabled={entries.length === 0}
            >
              {t("common.clear", "Clear")}
            </Button>
          </div>
        )}

        {entries.length === 0 ? (
          <div className={cn(styles.list, styles.empty)}>
            {t("settings.errorLog.empty", "No errors recorded.")}
          </div>
        ) : (
          <ul className={styles.list}>
            {entries.map((entry) => (
              <ErrorLogItem key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </Section>

      {/* On a phone only the list scrolls, so clearing sits in a bar below it
          that stays in view. */}
      {isMobile && entries.length > 0 && (
        <div className={styles.bottomBar}>
          <Button variant="outline" className="w-full" onClick={clearErrorLog}>
            {t("settings.errorLog.clearAll", "Clear all")}
          </Button>
        </div>
      )}
    </div>
  );
}
