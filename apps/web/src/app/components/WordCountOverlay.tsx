import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveEditor } from "../contexts/ActiveEditorContext";
import { usePageSettings } from "../contexts/PageSettingsContext";
import { WordCountDetails } from "./WordCountDetails";

export function WordCountOverlay() {
  const { showWordCount, wordCount } = usePageSettings();
  const { editor } = useActiveEditor();
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);

  const openDetails = useCallback(() => {
    // Drop the editor's focus so the soft keyboard retracts: these are read-only
    // statistics, and a drawer squeezed into the strip above an open keyboard
    // has no room for them. Blur before opening so the inset is already
    // collapsing as the drawer animates in.
    editor?.blur();
    setDetailsOpen(true);
  }, [editor]);

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
        // Open on pointerdown, not click. The dock rides above the soft
        // keyboard, so dismissing it drops this button by the keyboard's height
        // — and the browser hit-tests the synthesized click at the finger's
        // original coordinates afterwards, where the canvas now sits, so an
        // `onClick` tap never arrives (the engine's touchEnd handler documents
        // the same race). Acting on pointerdown settles the intent before any
        // of that; preventing the default also stops the button from taking
        // focus, leaving `openDetails` the one thing that retracts the
        // keyboard. `onClick` still covers keyboard activation (`detail === 0`).
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          e.preventDefault();
          openDetails();
        }}
        onClick={(e) => {
          if (e.detail === 0) openDetails();
        }}
        className="flex h-8 cursor-pointer select-none items-center rounded-full border border-border bg-popover/95 px-3 shadow-lg backdrop-blur-xl transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
