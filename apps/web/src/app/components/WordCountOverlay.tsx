import { useTranslation } from "react-i18next";
import { usePageSettings } from "../contexts/PageSettingsContext";

export function WordCountOverlay() {
  const { showWordCount, wordCount } = usePageSettings();
  const { i18n, t } = useTranslation();

  if (!showWordCount) {
    return null;
  }

  const formattedCount = new Intl.NumberFormat(i18n.language).format(wordCount);

  return (
    <div
      className="flex h-8 items-center rounded-full border border-border bg-popover/95 px-3 shadow-lg backdrop-blur-xl"
      role="status"
      aria-live="polite"
      aria-label={`Word count: ${formattedCount}`}
    >
      <span className="text-xs font-medium text-muted-foreground">
        {formattedCount} {wordCount === 1 ? t("common.word", "word") : t("common.words", "words")}
      </span>
    </div>
  );
}
