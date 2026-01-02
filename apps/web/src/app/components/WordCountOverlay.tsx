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
      className="fixed bottom-4 right-6 z-10 px-3 py-1.5 rounded-md bg-background/80 backdrop-blur-sm border border-border shadow-lg"
      role="status"
      aria-live="polite"
      aria-label={`Word count: ${formattedCount}`}
    >
      <span className="text-xs font-medium text-muted-foreground">
        {formattedCount} {wordCount === 1 ? t`word` : t`words`}
      </span>
    </div>
  );
}
