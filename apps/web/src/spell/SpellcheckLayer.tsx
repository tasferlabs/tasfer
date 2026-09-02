import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  isApplePlatform,
  type Doc,
  type DocPoint,
  type Editor,
} from "@tasfer/editor";
import { isTouchDevice } from "@tasfer/editor/internal";
import { replaceWord, SpellChecker, type FlagRef } from "@tasfer/spell";
import type { AppEditor } from "@/editorSchema";
import { useDocumentIgnores, readDocumentIgnores } from "./documentIgnores";
import { SPELL_PREF_KEYS } from "./personalDictionary";
import { useSpellService, useSpellSetting } from "./SpellProvider";
import { spellShortcutFor } from "./spellShortcut";
import { SuggestionBar, useSuggestionBarSlot } from "./SuggestionBar";
import { SuggestionPopover } from "./SuggestionPopover";

/**
 * The imperative face of the layer, for the context-menu builder, the footer
 * and tests. Every method is safe to call when spelling is unavailable (they
 * return null / do nothing).
 */
export interface SpellcheckLayerHandle {
  flagAtCaret(): FlagRef | null;
  flagAt(p: DocPoint): FlagRef | null;
  suggest(f: FlagRef): Promise<string[]>;
  apply(f: FlagRef, text: string): void;
  addToDictionary(f: FlagRef): void;
  ignoreOnce(f: FlagRef): void;
  ignoreInDocument(f: FlagRef): void;
  fixOrNext(): void;
  next(): void;
  prev(): void;
  count(): number;
}

export interface SpellcheckLayerProps {
  editor: AppEditor;
  doc: Doc;
  pageId: string;
  readonly: boolean;
  /** The editor surface's viewport rect, to translate canvas coords to screen. */
  getContainerRect: () => DOMRect | null | undefined;
  /** Where the popover portals; defaults to the document body. */
  portalContainer?: HTMLElement | null;
}

/** CSS variable the squiggle colour comes from; the fallback is the theme red. */
const UNDERLINE_VAR = "--editor-spell-underline";
const UNDERLINE_FALLBACK = "#e5484d";
/** A selection change this soon after a content change was typing, not a move. */
const TYPING_WINDOW_MS = 60;

/**
 * Window event the word-count footer fires to run fix-or-next on the page's
 * layer. A DOM event rather than a shared registry: the footer lives in the
 * app layout, outside the editor tree, and nothing module-global is needed
 * to reach the one layer that owns `pageId`.
 */
export const SPELL_FIX_OR_NEXT_EVENT = "tasfer:spell-fix-or-next";

export function requestSpellFixOrNext(pageId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ pageId: string }>(SPELL_FIX_OR_NEXT_EVENT, {
      detail: { pageId },
    }),
  );
}

function readRootCssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/** The caret as an absolute point; for a range, its head (`to`). */
function caretPoint(
  editor: AppEditor,
): { block: string; offset: number } | null {
  const range = editor.state.selection.range;
  if (!range || typeof range !== "object") return null;
  const point: DocPoint = "from" in range ? range.to : range;
  if (typeof point !== "object" || !("offset" in point)) return null;
  return { block: point.block, offset: point.offset ?? 0 };
}

interface PopoverState {
  flag: FlagRef;
  x: number;
  y: number;
  suggestions: string[] | null;
}

interface BarState {
  flag: FlagRef;
  suggestions: string[] | null;
}

/**
 * Spellcheck for one mounted, editable editor: builds the `SpellChecker`
 * (squiggles), owns the desktop chords, the suggestion popover, the touch
 * suggestion bar and the screen-reader live region, and reports the flag
 * count to the service for the footer. Renders nothing visible on its own.
 */
export const SpellcheckLayer = forwardRef<
  SpellcheckLayerHandle,
  SpellcheckLayerProps
>(function SpellcheckLayer(
  { editor, doc, pageId, readonly, getContainerRect, portalContainer },
  ref,
) {
  const { t } = useTranslation();
  const service = useSpellService();
  const slot = useSuggestionBarSlot();
  const enabled = useSpellSetting<boolean>(SPELL_PREF_KEYS.enabled, true).value;
  const highContrast = useSpellSetting<boolean>(
    SPELL_PREF_KEYS.highContrast,
    false,
  ).value;
  const flagAllCaps = useSpellSetting<boolean>(
    SPELL_PREF_KEYS.flagAllCaps,
    false,
  ).value;
  const lenientArabic = useSpellSetting<boolean>(
    SPELL_PREF_KEYS.lenientArabic,
    false,
  ).value;
  const ignores = useDocumentIgnores(pageId);

  const active = enabled && !readonly && service !== null;

  // Settings the checker reads through closures, so a flip never rebuilds it.
  const settingsRef = useRef({
    enabled,
    highContrast,
    flagAllCaps,
    lenientArabic,
  });
  settingsRef.current = { enabled, highContrast, flagAllCaps, lenientArabic };

  const checkerRef = useRef<SpellChecker | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [bar, setBar] = useState<BarState | null>(null);
  const [announcement, setAnnouncement] = useState<{
    text: string;
    lang?: string;
    seq: number;
  } | null>(null);
  const seqRef = useRef(0);
  const lastChangeAtRef = useRef(0);
  const barDismissedRef = useRef<string | null>(null);
  const touch = isTouchDevice();

  const announce = useCallback((text: string, lang?: string) => {
    seqRef.current += 1;
    setAnnouncement({ text, lang, seq: seqRef.current });
  }, []);

  // ── checker lifecycle ────────────────────────────────────────────────────
  // The checker speaks the schema-agnostic core `Editor`; the app editor is
  // that same object seen through its concrete schema.
  const coreEditor = editor as unknown as Editor;

  useEffect(() => {
    if (!service || readonly) return;
    const transport = service.transportFor(coreEditor, pageId);
    const checker = new SpellChecker({
      editor: coreEditor,
      doc,
      docId: pageId,
      transport,
      layer: "spell",
      color: () => readRootCssVar(UNDERLINE_VAR, UNDERLINE_FALLBACK),
      style: () => ({
        type: "underline",
        line: "wavy",
        thickness: settingsRef.current.highContrast ? 2 : 1,
      }),
      isEnabled: () => settingsRef.current.enabled,
      ignoredInDocument: () => readDocumentIgnores(pageId),
      flagAllCaps: () => settingsRef.current.flagAllCaps,
      lenientArabic: () => settingsRef.current.lenientArabic,
    });
    checkerRef.current = checker;
    const offFlags = checker.onFlagsChange((n) =>
      service.reportFlagCount(pageId, n),
    );
    return () => {
      offFlags();
      checker.dispose();
      transport.release();
      service.reportFlagCount(pageId, 0);
      if (checkerRef.current === checker) checkerRef.current = null;
    };
  }, [service, coreEditor, doc, pageId, readonly]);

  // Start/stop with the setting (stop clears the layer; start re-runs a pass).
  useEffect(() => {
    const checker = checkerRef.current;
    if (!checker) return;
    if (active) checker.start();
    else {
      checker.stop();
      setPopover(null);
      setBar(null);
    }
  }, [active, service, editor, pageId]);

  // A changed rule set means every block is re-checked; skipped on mount.
  const firstSettingsRun = useRef(true);
  useEffect(() => {
    if (firstSettingsRun.current) {
      firstSettingsRun.current = false;
      return;
    }
    checkerRef.current?.invalidateAll();
  }, [highContrast, flagAllCaps, lenientArabic, ignores.ignored]);

  // ── geometry ─────────────────────────────────────────────────────────────
  const anchorFor = useCallback(
    (flag: FlagRef): { x: number; y: number } | null => {
      const span = checkerRef.current?.currentRange(flag) ?? {
        from: flag.from,
        to: flag.to,
      };
      const a = editor.view.coordsAtPos({
        block: flag.blockId,
        offset: span.from,
      });
      const b = editor.view.coordsAtPos({
        block: flag.blockId,
        offset: span.to,
      });
      const rect = getContainerRect();
      if (!a || !rect) return null;
      // Visual start of the word: the smaller x, so an RTL word anchors at its
      // right edge's counterpart on the left in the same way an LTR word does.
      return {
        x: rect.left + Math.min(a.x, b?.x ?? a.x),
        y: rect.top + a.y + a.height,
      };
    },
    [editor, getContainerRect],
  );

  const wordRange = (flag: FlagRef) => {
    const span = checkerRef.current?.currentRange(flag) ?? {
      from: flag.from,
      to: flag.to,
    };
    return {
      from: { block: flag.blockId, offset: span.from },
      to: { block: flag.blockId, offset: span.to },
    };
  };

  // ── actions ──────────────────────────────────────────────────────────────
  const flagAt = useCallback(
    (p: DocPoint) => checkerRef.current?.flagAt(p) ?? null,
    [],
  );
  const flagAtCaret = useCallback(() => {
    const p = caretPoint(editor);
    return p ? flagAt(p) : null;
  }, [editor, flagAt]);

  const suggest = useCallback(
    (f: FlagRef) => checkerRef.current?.suggest(f) ?? Promise.resolve([]),
    [],
  );

  const announceFlag = useCallback(
    (flag: FlagRef, suggestions: string[]) => {
      announce(
        suggestions.length === 0
          ? t(
              "spell.announce.flagNone",
              "{{word}}: misspelled, no suggestions",
              {
                word: flag.word,
              },
            )
          : t("spell.announce.flag", {
              count: suggestions.length,
              word: flag.word,
              defaultValue_one: "{{word}}: misspelled, {{count}} suggestion",
              defaultValue_other: "{{word}}: misspelled, {{count}} suggestions",
            }),
        flag.script === "arab"
          ? "ar"
          : flag.script === "latn"
            ? "en"
            : undefined,
      );
    },
    [announce, t],
  );

  const openPopover = useCallback(
    (flag: FlagRef) => {
      const at = anchorFor(flag);
      if (!at) return;
      setPopover({ flag, x: at.x, y: at.y, suggestions: null });
      void suggest(flag).then((s) => {
        setPopover((p) =>
          p && p.flag === flag ? { ...p, suggestions: s } : p,
        );
        announceFlag(flag, s);
      });
    },
    [anchorFor, suggest, announceFlag],
  );

  const showBar = useCallback(
    (flag: FlagRef) => {
      setBar({ flag, suggestions: null });
      void suggest(flag).then((s) => {
        setBar((b) => (b && b.flag === flag ? { ...b, suggestions: s } : b));
        announceFlag(flag, s);
      });
    },
    [suggest, announceFlag],
  );

  const closeAll = useCallback(() => {
    setPopover(null);
    setBar(null);
  }, []);

  /** Select the word, bring it on screen and offer suggestions. */
  const goTo = useCallback(
    (flag: FlagRef) => {
      const range = wordRange(flag);
      editor.setSelection(range);
      editor.view.scrollToPosition(range.from);
      if (touch) showBar(flag);
      else openPopover(flag);
    },
    // wordRange only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, touch, showBar, openPopover],
  );

  const apply = useCallback(
    (f: FlagRef, text: string) => {
      closeAll();
      if (replaceWord(coreEditor, f, text)) {
        announce(
          t("spell.announce.changed", "Changed to {{word}}", { word: text }),
        );
      }
      editor.focus();
    },
    [coreEditor, editor, closeAll, announce, t],
  );

  const addToDictionary = useCallback(
    (f: FlagRef) => {
      closeAll();
      service?.addWord(f.word);
      checkerRef.current?.dropWord(f.word);
      announce(
        t("spell.announce.added", "Added {{word}} to your dictionary", {
          word: f.word,
        }),
      );
      editor.focus();
    },
    [service, editor, closeAll, announce, t],
  );

  const ignoreOnce = useCallback(
    (f: FlagRef) => {
      closeAll();
      checkerRef.current?.ignoreOnce(f);
      announce(
        t("spell.announce.ignoredOnce", "{{word}} ignored", { word: f.word }),
      );
      editor.focus();
    },
    [editor, closeAll, announce, t],
  );

  const ignoreInDocument = useCallback(
    (f: FlagRef) => {
      closeAll();
      ignores.add(f.word);
      checkerRef.current?.dropWord(f.word);
      announce(
        t("spell.announce.ignored", "{{word}} ignored on this page", {
          word: f.word,
        }),
      );
      editor.focus();
    },
    [ignores, editor, closeAll, announce, t],
  );

  const stepTo = useCallback(
    (direction: "next" | "prev") => {
      const checker = checkerRef.current;
      if (!checker || !active) return;
      const from = caretPoint(editor) ?? "caret";
      const flag =
        direction === "next"
          ? checker.next(from, true)
          : checker.prev(from, true);
      if (!flag) {
        closeAll();
        announce(t("spell.announce.noMore", "No more misspelled words"));
        return;
      }
      goTo(flag);
    },
    [editor, active, goTo, closeAll, announce, t],
  );

  const fixOrNext = useCallback(() => {
    if (!active) return;
    const here = flagAtCaret();
    if (here) {
      if (touch) showBar(here);
      else openPopover(here);
      return;
    }
    stepTo("next");
  }, [active, flagAtCaret, touch, showBar, openPopover, stepTo]);

  const next = useCallback(() => stepTo("next"), [stepTo]);
  const prev = useCallback(() => stepTo("prev"), [stepTo]);
  const count = useCallback(() => checkerRef.current?.count() ?? 0, []);

  useImperativeHandle(
    ref,
    () => ({
      flagAtCaret,
      flagAt,
      suggest,
      apply,
      addToDictionary,
      ignoreOnce,
      ignoreInDocument,
      fixOrNext,
      next,
      prev,
      count,
    }),
    [
      flagAtCaret,
      flagAt,
      suggest,
      apply,
      addToDictionary,
      ignoreOnce,
      ignoreInDocument,
      fixOrNext,
      next,
      prev,
      count,
    ],
  );

  // ── follow the document ──────────────────────────────────────────────────
  // Typing closes the popover/bar; a caret move re-anchors the popover, closes
  // it when the caret leaves the word, and (on touch) docks the bar when the
  // caret lands in a misspelled word by a tap rather than by typing.
  const popoverRef = useRef(popover);
  popoverRef.current = popover;
  const barRef = useRef(bar);
  barRef.current = bar;
  useEffect(() => {
    if (!active) return;
    const offChange = editor.on("change", () => {
      lastChangeAtRef.current = performance.now();
      if (popoverRef.current) setPopover(null);
      if (barRef.current) setBar(null);
    });
    const offSelection = editor.on("selectionchange", () => {
      const typing =
        performance.now() - lastChangeAtRef.current < TYPING_WINDOW_MS;
      const here = flagAtCaret();
      const open = popoverRef.current;
      if (
        open &&
        (!here ||
          here.blockId !== open.flag.blockId ||
          here.from !== open.flag.from)
      ) {
        setPopover(null);
      }
      if (!touch) return;
      const docked = barRef.current;
      if (
        docked &&
        (!here ||
          here.word !== docked.flag.word ||
          here.blockId !== docked.flag.blockId)
      ) {
        setBar(null);
        barDismissedRef.current = null;
      }
      if (here && !typing && !docked) {
        const key = `${here.blockId}:${here.from}:${here.word}`;
        if (barDismissedRef.current !== key) showBar(here);
      }
    });
    // Scroll and layout move the word; keep the popover pinned to it, and
    // drop it the moment the word is gone.
    const offSnapshot = editor.subscribe(() => {
      const open = popoverRef.current;
      if (!open) return;
      if (checkerRef.current && !checkerRef.current.currentRange(open.flag)) {
        setPopover(null);
        return;
      }
      const at = anchorFor(open.flag);
      if (!at) return;
      setPopover((p) =>
        p && (p.x !== at.x || p.y !== at.y) ? { ...p, x: at.x, y: at.y } : p,
      );
    });
    return () => {
      offChange();
      offSelection();
      offSnapshot();
    };
  }, [active, editor, touch, flagAtCaret, showBar, anchorFor]);

  // ── desktop chords ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const which = spellShortcutFor(e, isApplePlatform());
      if (!which) return;
      // Same guards as the find chord: never over a dialog, never when another
      // text field owns the keyboard.
      if (document.querySelector('[role="dialog"]')) return;
      const el = document.activeElement;
      if (
        el &&
        el !== document.body &&
        !editor.state.isFocused &&
        (el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement ||
          (el as HTMLElement).isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (which === "prev") prev();
      else fixOrNext();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, editor, prev, fixOrNext]);

  // The footer's "Spelling: n" pill.
  useEffect(() => {
    if (!active) return;
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<{ pageId: string }>).detail;
      if (detail?.pageId !== pageId) return;
      editor.focus();
      fixOrNext();
    };
    window.addEventListener(SPELL_FIX_OR_NEXT_EVENT, onRequest);
    return () => window.removeEventListener(SPELL_FIX_OR_NEXT_EVENT, onRequest);
  }, [active, pageId, editor, fixOrNext]);

  // ── touch bar into the keyboard toolbar slot ─────────────────────────────
  useEffect(() => {
    if (!slot) return;
    if (!bar || !active) {
      slot.setContent(null);
      return;
    }
    const flag = bar.flag;
    slot.setContent(
      <SuggestionBar
        flag={flag}
        suggestions={bar.suggestions}
        onApply={(s) => apply(flag, s)}
        onAdd={() => addToDictionary(flag)}
        onIgnore={() => ignoreOnce(flag)}
        onDismiss={() => {
          barDismissedRef.current = `${flag.blockId}:${flag.from}:${flag.word}`;
          setBar(null);
        }}
      />,
    );
    return () => slot.setContent(null);
    // `slot` is a stable per-host context; its identity changes with `content`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bar, active, apply, addToDictionary, ignoreOnce]);

  return (
    <>
      {/* Polite live region: navigation and outcomes, for screen readers. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement && (
          <span key={announcement.seq} lang={announcement.lang}>
            {announcement.text}
          </span>
        )}
      </div>
      {popover && active && (
        <SuggestionPopover
          flag={popover.flag}
          suggestions={popover.suggestions}
          x={popover.x}
          y={popover.y}
          container={portalContainer}
          onApply={(s) => apply(popover.flag, s)}
          onAdd={() => addToDictionary(popover.flag)}
          onIgnore={() => ignoreOnce(popover.flag)}
          onClose={() => setPopover(null)}
          onActiveChange={(s) => {
            if (s !== null && popover.suggestions) announce(s);
          }}
          ignoredCount={ignores.ignored.size}
          onClearIgnored={() => {
            ignores.clear();
            checkerRef.current?.invalidateAll();
          }}
        />
      )}
    </>
  );
});
