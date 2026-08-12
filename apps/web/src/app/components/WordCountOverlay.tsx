import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveEditor } from "../contexts/ActiveEditorContext";
import { usePageSettings } from "../contexts/PageSettingsContext";
import { WordCountDetails } from "./WordCountDetails";

export function WordCountOverlay() {
  const { showWordCount, wordCount, selectionStats } = usePageSettings();
  const { editor } = useActiveEditor();
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  const openDetails = useCallback(() => {
    // Drop the editor's focus so the soft keyboard retracts: these are read-only
    // statistics, and a drawer squeezed into the strip above an open keyboard
    // has no room for them. Blur before opening so the inset is already
    // collapsing as the drawer animates in.
    editor?.blur();
    setDetailsOpen(true);
  }, [editor]);

  // With text selected the pill counts that text, not the document.
  const label = selectionStats
    ? t("common.wordCountSelected", {
        count: selectionStats.words,
        defaultValue_one: "{{count, number}} word selected",
        defaultValue_other: "{{count, number}} words selected",
      })
    : t("common.wordCount", {
        count: wordCount,
        defaultValue_one: "{{count, number}} word",
        defaultValue_other: "{{count, number}} words",
      });

  // `initial={false}` so the pill is simply present on a page that already has
  // the setting on; only toggling it animates.
  return (
    <>
      <AnimatePresence initial={false}>
        {showWordCount && (
          <motion.button
            key="word-count"
            type="button"
            initial={{ opacity: 0, y: 4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.96 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.15 }}
            // Open on pointerdown, not click. The dock rides above the soft
            // keyboard, so dismissing it drops this button by the keyboard's
            // height — and the browser hit-tests the synthesized click at the
            // finger's original coordinates afterwards, where the canvas now
            // sits, so an `onClick` tap never arrives (the engine's touchEnd
            // handler documents the same race). Acting on pointerdown settles
            // the intent before any of that; preventing the default also stops
            // the button from taking focus, leaving `openDetails` the one thing
            // that retracts the keyboard. `onClick` still covers keyboard
            // activation (`detail === 0`).
            onPointerDown={(e) => {
              if (!e.isPrimary || e.button !== 0) return;
              e.preventDefault();
              openDetails();
            }}
            onClick={(e) => {
              if (e.detail === 0) openDetails();
            }}
            className="flex h-8 cursor-pointer select-none items-center rounded-full border border-border bg-popover/95 px-3 shadow-lg backdrop-blur-xl transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={
              selectionStats
                ? t("wordCount.showSelectionDetails", "Show selection statistics")
                : t("wordCount.showDetails", "Show document statistics")
            }
            aria-haspopup="dialog"
          >
            <span className="text-xs font-medium text-muted-foreground">
              {label}
            </span>
          </motion.button>
        )}
      </AnimatePresence>
      {showWordCount && (
        <WordCountDetails open={detailsOpen} onOpenChange={setDetailsOpen} />
      )}
    </>
  );
}
