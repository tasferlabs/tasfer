import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useActiveEditor } from "../contexts/ActiveEditorContext";
import { usePageSettings } from "../contexts/PageSettingsContext";
import { requestSpellFixOrNext } from "@/spell/SpellcheckLayer";
import { useSpellService } from "@/spell/SpellProvider";
import { WordCountDetails } from "./WordCountDetails";

/** The page's live misspelling count, as reported by its SpellcheckLayer. */
function useSpellFlagCount(pageId: string | null): number {
  const service = useSpellService();
  const subscribe = useCallback(
    (onChange: () => void) =>
      service ? service.subscribe(onChange) : () => {},
    [service],
  );
  return useSyncExternalStore(
    subscribe,
    () => (service && pageId ? service.flagCount(pageId) : 0),
    () => 0,
  );
}

export function WordCountOverlay() {
  const { showWordCount, wordCount, selectionStats, pageId } =
    usePageSettings();
  const { editor } = useActiveEditor();
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const spellCount = useSpellFlagCount(pageId);

  const openDetails = useCallback(() => {
    // Drop the editor's focus so the soft keyboard retracts: these are read-only
    // statistics, and a drawer squeezed into the strip above an open keyboard
    // has no room for them. Blur before opening so the inset is already
    // collapsing as the drawer animates in.
    editor?.blur();
    setDetailsOpen(true);
  }, [editor]);

  // Fix-or-next on the page's spelling layer: the layer focuses the editor and
  // either offers suggestions for the caret word or jumps to the next one.
  const fixSpelling = useCallback(() => {
    if (pageId) requestSpellFixOrNext(pageId);
  }, [pageId]);

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

  const pillClass =
    "flex h-8 cursor-pointer select-none items-center rounded-full border border-border bg-popover/95 px-3 shadow-lg backdrop-blur-xl transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const motionProps = {
    initial: { opacity: 0, y: 4, scale: 0.96 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: 4, scale: 0.96 },
    transition: reduceMotion ? { duration: 0 } : { duration: 0.15 },
  };

  // `initial={false}` so the pill is simply present on a page that already has
  // the setting on; only toggling it animates.
  return (
    <>
      <AnimatePresence initial={false}>
        {spellCount > 0 && (
          <motion.button
            key="spelling-count"
            type="button"
            {...motionProps}
            onClick={fixSpelling}
            className={pillClass}
            aria-label={t(
              "spell.footer.fixNext",
              "Fix spelling or go to the next misspelled word",
            )}
          >
            <span className="text-xs font-medium text-muted-foreground">
              {t("spell.footer.count", {
                count: spellCount,
                defaultValue_one: "{{count, number}} spelling issue",
                defaultValue_other: "{{count, number}} spelling issues",
              })}
            </span>
          </motion.button>
        )}
        {showWordCount && (
          <motion.button
            key="word-count"
            type="button"
            {...motionProps}
            // The dock settles the tap on pointerdown (it rides the keyboard,
            // where a `click` never arrives) and forwards it here as a
            // synthesized click; see BottomToolDock.
            onClick={openDetails}
            className={pillClass}
            aria-label={
              selectionStats
                ? t(
                    "wordCount.showSelectionDetails",
                    "Show selection statistics",
                  )
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
