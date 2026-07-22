import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePageSettings } from "../contexts/PageSettingsContext";
import { WordCountDetails } from "./WordCountDetails";

export function WordCountOverlay() {
  const { showWordCount, wordCount } = usePageSettings();
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (!showWordCount) {
    return null;
  }

  const label = t("common.wordCount", {
    count: wordCount,
    defaultValue_one: "{{count, number}} word",
    defaultValue_other: "{{count, number}} words",
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setDetailsOpen(true)}
        className="flex h-8 cursor-pointer items-center rounded-full border border-border bg-popover/95 px-3 shadow-lg backdrop-blur-xl transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("wordCount.showDetails", "Show document statistics")}
        aria-haspopup="dialog"
      >
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
      </button>
      <WordCountDetails open={detailsOpen} onOpenChange={setDetailsOpen} />
    </>
  );
}
