import {
  normalizeShortcut,
  parseShortcut,
  shortcutFromEvent,
} from "@tasfer/editor";
import {
  Lock,
  MoreHorizontal,
  RotateCcw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConfirmation } from "@/app/components/ConfirmationDialog";
import { cn } from "@/lib/utils";
import {
  scopeLabel,
  type ShortcutCommand,
  type ShortcutScope,
} from "@/shortcuts/commands";
import {
  modifierKeycaps,
  shortcutKeycaps,
  shortcutText,
} from "@/shortcuts/keycaps";
import {
  type Shortcuts as ShortcutTable,
  useShortcutBindings,
  useShortcutsDialog,
} from "@/shortcuts/ShortcutsContext";
import styles from "./ShortcutsDialog.module.css";

const SCOPE_ORDER: readonly ShortcutScope[] = [
  "general",
  "editor",
  "calendar",
  "desktop",
];

/** What the rail picks: every shortcut, one scope, or only the changed ones. */
type Category = "all" | ShortcutScope | "custom";

/** The row listening for new keys, and what it has heard so far. */
interface Recording {
  id: string;
  /** Modifiers held down right now, as keycaps. */
  held: string[];
  /** A chord that can't be used here, kept on screen with the reason. */
  rejected: string | null;
}

/** New chords for a row that some other command already answers. */
interface Conflict {
  id: string;
  chords: readonly string[];
}

/**
 * Every shortcut, grouped by where it works, with a rail to narrow them down.
 * A row is changed by clicking its keys and pressing new ones; changes sync to
 * the person's other devices. Opened from the command palette and Settings →
 * Preferences. Desktop only: a phone has no keyboard to set shortcuts for, so
 * the host leaves it unmounted there.
 */
export function ShortcutsDialog() {
  const { open, setOpen } = useShortcutsDialog();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className={styles.dialog}>
        {/* Content unmounts on close, so every opening starts fresh. */}
        <ShortcutsPanel onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const shortcuts = useShortcutBindings();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const { getConfirmation } = useConfirmation();

  const changedCount = shortcuts.commands.filter((c) =>
    shortcuts.isChanged(c.id),
  ).length;
  const scopes = SCOPE_ORDER.filter((scope) =>
    shortcuts.commands.some((c) => c.scope === scope),
  );

  const needle = query.trim().toLowerCase();
  const visible = shortcuts.commands.filter((command) => {
    if (needle) {
      const chords = shortcuts.bindings(command.id);
      const haystack = [
        command.label(t),
        scopeLabel(command.scope, t),
        ...chords.map((c) => shortcutText(c, shortcuts.apple)),
        ...chords.map((c) => shortcutKeycaps(c, shortcuts.apple).join(" ")),
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(needle);
    }
    if (category === "custom") return shortcuts.isChanged(command.id);
    return category === "all" || command.scope === category;
  });
  const groups = scopes
    .map((scope) => ({
      scope,
      commands: visible.filter((c) => c.scope === scope),
    }))
    .filter((g) => g.commands.length > 0);

  // A chord is saved the moment it is pressed — unless another command has
  // it, in which case the row asks first.
  const assign = (id: string, chords: readonly string[]) => {
    const clash = chords.some((c) => shortcuts.conflicts(c, id).length > 0);
    if (clash) setConflict({ id, chords });
    else {
      shortcuts.set(id, chords);
      setConflict(null);
    }
  };

  const replace = ({ id, chords }: Conflict) => {
    for (const chord of chords) {
      const wanted = normalizeShortcut(chord, shortcuts.apple);
      for (const other of shortcuts.conflicts(chord, id)) {
        shortcuts.set(
          other.id,
          shortcuts
            .bindings(other.id)
            .filter((b) => normalizeShortcut(b, shortcuts.apple) !== wanted),
        );
      }
    }
    shortcuts.set(id, chords);
    setConflict(null);
  };

  const startRecording = (id: string) => {
    setConflict(null);
    setRecording({ id, held: [], rejected: null });
  };

  // While a row records, every key goes to it: the app's shortcuts stand down,
  // and Escape cancels the recording rather than closing the dialog.
  const recordingId = recording?.id ?? null;
  const assignRef = useRef(assign);
  assignRef.current = assign;
  useEffect(() => {
    if (!recordingId) return;
    const command = shortcuts.command(recordingId);
    if (!command) return;
    const resume = shortcuts.pause();
    const isModifier = (key: string) =>
      key === "Meta" ||
      key === "Control" ||
      key === "Alt" ||
      key === "Shift" ||
      key === "OS";
    const onKeyDown = (e: KeyboardEvent) => {
      const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      // Tab moves on, as it does anywhere, and ends the recording on the way.
      if (bare && e.key === "Tab") {
        setRecording(null);
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (isModifier(e.key)) {
        setRecording({
          id: recordingId,
          held: modifierKeycaps(e, shortcuts.apple),
          rejected: null,
        });
        return;
      }
      if (bare && e.key === "Escape") {
        setRecording(null);
        return;
      }
      if (bare && (e.key === "Backspace" || e.key === "Delete")) {
        shortcuts.set(recordingId, []);
        setRecording(null);
        return;
      }
      const chord = shortcutFromEvent(e, shortcuts.apple);
      if (!chord) return;
      if (chordProblem(command, chord)) {
        setRecording({ id: recordingId, held: [], rejected: chord });
        return;
      }
      setRecording(null);
      assignRef.current(recordingId, [chord]);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isModifier(e.key)) return;
      setRecording((r) =>
        r && !r.rejected
          ? { ...r, held: modifierKeycaps(e, shortcuts.apple) }
          : r,
      );
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      resume();
    };
  }, [recordingId, shortcuts]);

  // An open conflict takes Escape first: it dismisses the question and leaves
  // the dialog open.
  const asking = conflict !== null;
  useEffect(() => {
    if (!asking) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setConflict(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [asking]);

  const pick = (next: Category) => {
    setCategory(next);
    setQuery("");
    setConflict(null);
  };

  const askReset = async () => {
    setRecording(null);
    setConflict(null);
    const confirmed = await getConfirmation({
      title: t("shortcuts.resetAllConfirm", {
        count: changedCount,
        defaultValue_one:
          "Reset {{count, number}} customized shortcut to its default?",
        defaultValue_other:
          "Reset {{count, number}} customized shortcuts to their defaults?",
      }),
      description: t(
        "shortcuts.resetAllBody",
        "This can’t be undone, and applies on all your devices.",
      ),
      confirmText: t("shortcuts.resetAll", "Reset all"),
    });
    if (confirmed) shortcuts.resetAll();
  };

  const listFormat = useMemo(
    () => new Intl.ListFormat(i18n.language, { type: "conjunction" }),
    [i18n.language],
  );
  const modifiers = useMemo(
    () =>
      new Intl.ListFormat(i18n.language, { type: "disjunction" }).format(
        shortcuts.apple ? ["⌘", "⌥", "⌃"] : ["Ctrl", "Alt"],
      ),
    [i18n.language, shortcuts.apple],
  );

  const railItem = (
    id: Category,
    label: string,
    count: number,
  ): React.ReactNode => {
    const selected = !needle && category === id;
    return (
      <button
        key={id}
        type="button"
        className={cn(styles.railItem, selected && styles.railItemSelected)}
        aria-current={selected ? "page" : undefined}
        onClick={() => pick(id)}
      >
        <span className={styles.railLabel}>{label}</span>
        <span className={styles.railCount}>{count}</span>
      </button>
    );
  };

  return (
    <>
      <div className={styles.header}>
        <div className={styles.heading}>
          <DialogTitle>
            {t("shortcuts.title", "Keyboard shortcuts")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "shortcuts.clickToRecord",
              "Click any shortcut to record a new one.",
            )}
          </DialogDescription>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("shortcuts.moreOptions", "More options")}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={styles.menu}>
            {/* Faded red reads as brown; with nothing to reset the item is
                plain disabled, not a dimmed warning. */}
            <DropdownMenuItem
              variant={changedCount === 0 ? "default" : "destructive"}
              disabled={changedCount === 0}
              onSelect={askReset}
            >
              <RotateCcw />
              {t("shortcuts.resetAllMenu", "Reset all to defaults…")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("common.close", "Close")}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      <div className={styles.search}>
        <InputGroup>
          <InputGroupAddon align="inline-start">
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setConflict(null);
            }}
            placeholder={t(
              "shortcuts.searchPlaceholder",
              "Search by name or keys",
            )}
            aria-label={t("shortcuts.searchLabel", "Search shortcuts")}
          />
        </InputGroup>
      </div>

      <div className={styles.body}>
        <nav
          className={styles.rail}
          aria-label={t("shortcuts.categories", "Shortcut categories")}
        >
          {railItem(
            "all",
            t("shortcuts.all", "All shortcuts"),
            shortcuts.commands.length,
          )}
          {scopes.map((scope) =>
            railItem(
              scope,
              scopeLabel(scope, t),
              shortcuts.commands.filter((c) => c.scope === scope).length,
            ),
          )}
          <div className={styles.railDivider} aria-hidden />
          {railItem(
            "custom",
            t("shortcuts.customized", "Customized"),
            changedCount,
          )}
        </nav>

        <div className={styles.list}>
          {groups.length === 0 ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>
                {needle
                  ? t("shortcuts.noMatch", "No shortcuts match “{{query}}”", {
                      query: query.trim(),
                      interpolation: { escapeValue: false },
                    })
                  : t("shortcuts.noneCustomized", "Nothing customized yet")}
              </p>
              <p className={styles.emptyBody}>
                {needle
                  ? t(
                      "shortcuts.noMatchHint",
                      "Try another word, or the keys themselves.",
                    )
                  : t(
                      "shortcuts.noneCustomizedHint",
                      "Shortcuts you change show up here.",
                    )}
              </p>
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.scope} className={styles.group}>
                <h3 className={styles.groupLabel}>
                  {scopeLabel(group.scope, t)}
                </h3>
                {group.commands.map((command) => (
                  <ShortcutRow
                    key={command.id}
                    command={command}
                    shortcuts={shortcuts}
                    recording={recording?.id === command.id ? recording : null}
                    conflict={conflict?.id === command.id ? conflict : null}
                    modifiers={modifiers}
                    listFormat={listFormat}
                    onRecord={() => startRecording(command.id)}
                    onStopRecording={() =>
                      setRecording((r) => (r?.id === command.id ? null : r))
                    }
                    onReset={() => assign(command.id, command.defaults)}
                    onCancelConflict={() => setConflict(null)}
                    onReplace={() => conflict && replace(conflict)}
                    onUseInstead={(chord) => assign(command.id, [chord])}
                  />
                ))}
              </section>
            ))
          )}
        </div>
      </div>

      <div className={styles.footer}>
        <Button size="sm" onClick={onClose}>
          {t("common.done", "Done")}
        </Button>
      </div>
    </>
  );
}

function ShortcutRow({
  command,
  shortcuts,
  recording,
  conflict,
  modifiers,
  listFormat,
  onRecord,
  onStopRecording,
  onReset,
  onCancelConflict,
  onReplace,
  onUseInstead,
}: {
  command: ShortcutCommand;
  shortcuts: ShortcutTable;
  recording: Recording | null;
  conflict: Conflict | null;
  modifiers: string;
  listFormat: Intl.ListFormat;
  onRecord: () => void;
  onStopRecording: () => void;
  onReset: () => void;
  onCancelConflict: () => void;
  onReplace: () => void;
  onUseInstead: (chord: string) => void;
}) {
  const { t } = useTranslation();
  const label = command.label(t);
  const chords = shortcuts.bindings(command.id);
  const changed = shortcuts.isChanged(command.id);
  const { apple } = shortcuts;
  const current = listFormat.format(chords.map((c) => shortcutText(c, apple)));

  // The first new chord that another command has, and who has it.
  const clash = conflict
    ? conflict.chords
        .map((chord) => ({
          chord,
          owners: shortcuts.conflicts(chord, command.id),
        }))
        .find((c) => c.owners.length > 0)
    : undefined;
  const canReplace =
    !!conflict &&
    conflict.chords.every((chord) =>
      shortcuts.conflicts(chord, command.id).every((c) => !c.locked),
    );
  const macText = !!clash?.owners.some((c) => c.locked && c.macText);
  // ⌃ pressed for ⌘ is the likeliest slip on a Mac. Offer the ⌘ chord when no
  // other command has it — or point out that this one already does.
  const guess =
    clash && conflict!.chords.length === 1
      ? commandKeyGuess(clash.chord, apple)
      : null;
  const suggestion =
    guess && shortcuts.conflicts(guess, command.id).length === 0 ? guess : null;
  const suggestionSet =
    !!suggestion &&
    chords.some(
      (c) =>
        normalizeShortcut(c, apple) === normalizeShortcut(suggestion, apple),
    );

  if (command.locked) {
    return (
      <div className={styles.row}>
        <div className={styles.rowMain}>
          <span className={styles.rowLabel}>{label}</span>
          <span className={styles.builtIn}>
            <Lock size={12} aria-hidden />
            {t("shortcuts.builtIn", "Built-in")}
          </span>
        </div>
        <span
          className={styles.keysStatic}
          aria-label={t(
            "shortcuts.lockedKeysLabel",
            "{{command}}: {{keys}}, built in",
            {
              command: label,
              keys: current,
              interpolation: { escapeValue: false },
            },
          )}
        >
          <ChordList chords={chords} apple={apple} tone="locked" />
        </span>
      </div>
    );
  }

  const keysLabel = recording
    ? t(
        "shortcuts.recordingLabel",
        "Recording a shortcut for {{command}}. Press the new keys, or Escape to cancel.",
        { command: label, interpolation: { escapeValue: false } },
      )
    : chords.length > 0
      ? t("shortcuts.keysLabel", "{{command}}: {{keys}}. Press to change.", {
          command: label,
          keys: current,
          interpolation: { escapeValue: false },
        })
      : t(
          "shortcuts.unsetLabel",
          "{{command}}: no shortcut. Press to set one.",
          {
            command: label,
            interpolation: { escapeValue: false },
          },
        );

  const recordHelp = t(
    "shortcuts.recordHelp",
    "Press the new keys · {{escape}} to cancel · {{clear}} to clear",
    {
      escape: shortcutKeycaps("escape", apple)[0],
      clear: shortcutKeycaps("backspace", apple)[0],
      interpolation: { escapeValue: false },
    },
  );

  return (
    <div className={styles.rowWrap}>
      <div className={styles.row}>
        <div className={styles.rowMain}>
          <span className={styles.rowLabel}>{label}</span>
          {changed && (
            <Badge variant="secondary">
              {t("shortcuts.editedBadge", "Edited")}
            </Badge>
          )}
        </div>
        {changed && !recording && !conflict && (
          <IconTip label={t("shortcuts.reset", "Reset to default")}>
            <Button
              variant="ghost"
              size="icon-xs"
              className={styles.rowAction}
              aria-label={t(
                "shortcuts.resetFor",
                "Reset {{command}} to default",
                {
                  command: label,
                  interpolation: { escapeValue: false },
                },
              )}
              onClick={onReset}
            >
              <RotateCcw />
            </Button>
          </IconTip>
        )}
        <button
          type="button"
          className={cn(
            styles.keys,
            recording && styles.keysRecording,
            clash && styles.keysConflict,
          )}
          aria-label={keysLabel}
          onClick={(e) => {
            // Safari gives a clicked button no focus; the recording needs it
            // to end on blur.
            e.currentTarget.focus();
            onRecord();
          }}
          onBlur={onStopRecording}
        >
          {recording ? (
            recording.rejected ? (
              <Keycaps
                keys={shortcutKeycaps(recording.rejected, apple)}
                tone="recording"
              />
            ) : recording.held.length > 0 ? (
              <Keycaps keys={recording.held} tone="recording" />
            ) : (
              <span className={styles.waiting}>
                {t("shortcuts.pressKeys", "Press keys…")}
              </span>
            )
          ) : clash ? (
            <ChordList
              chords={conflict!.chords}
              apple={apple}
              tone="conflict"
            />
          ) : chords.length > 0 ? (
            <ChordList chords={chords} apple={apple} />
          ) : (
            <span className={styles.unset}>
              {t("shortcuts.notSet", "Not set")}
            </span>
          )}
        </button>
      </div>

      {recording && (
        <p className={styles.recordNote} aria-live="polite">
          {recording.rejected ? (
            <span className={styles.recordNoteError}>
              {t(
                "shortcuts.needsModifier",
                "Add {{modifiers}} — on its own, this key types text.",
                { modifiers, interpolation: { escapeValue: false } },
              )}
            </span>
          ) : (
            recordHelp
          )}
        </p>
      )}

      {clash && (
        <div className={styles.conflict} role="alert">
          <TriangleAlert
            size={16}
            className={styles.conflictIcon}
            aria-hidden
          />
          <p className={styles.conflictText}>
            <Trans
              i18nKey="shortcuts.conflictWith"
              defaults="<keys /> is already used by <b>{{commands}}</b>."
              values={{
                commands: listFormat.format(
                  clash.owners.map((c) => c.label(t)),
                ),
              }}
              tOptions={{ interpolation: { escapeValue: false } }}
              components={{
                keys: (
                  <Keycaps
                    keys={shortcutKeycaps(clash.chord, apple)}
                    tone="conflict"
                  />
                ),
                b: <strong />,
              }}
            />{" "}
            <span className={styles.conflictTail}>
              {canReplace
                ? t(
                    "shortcuts.conflictReplaceHint",
                    "Replacing removes it from there.",
                  )
                : macText
                  ? t(
                      "shortcuts.conflictMacText",
                      "It’s a standard macOS text shortcut, so it can’t be reassigned.",
                    )
                  : t(
                      "shortcuts.conflictLocked",
                      "Built-in shortcuts can’t be reassigned.",
                    )}
            </span>
            {suggestion && (
              <>
                {" "}
                {suggestionSet ? (
                  <Trans
                    i18nKey="shortcuts.didYouMeanSet"
                    defaults="Did you mean <keys />? It’s already set for this command."
                    components={{
                      keys: (
                        <Keycaps keys={shortcutKeycaps(suggestion, apple)} />
                      ),
                    }}
                  />
                ) : (
                  <Trans
                    i18nKey="shortcuts.didYouMean"
                    defaults="Did you mean <keys />?"
                    components={{
                      keys: (
                        <Keycaps keys={shortcutKeycaps(suggestion, apple)} />
                      ),
                    }}
                  />
                )}
              </>
            )}
          </p>
          <Button variant="ghost" size="xs" onClick={onCancelConflict}>
            {t("common.cancel", "Cancel")}
          </Button>
          {suggestion && !suggestionSet && (
            <Button
              variant={canReplace ? "outline" : "default"}
              size="xs"
              onClick={() => onUseInstead(suggestion)}
            >
              {/* The keys stay left to right inside an Arabic label. */}
              <Trans
                i18nKey="shortcuts.useInstead"
                defaults="Use <bdi>{{keys}}</bdi>"
                values={{ keys: shortcutText(suggestion, apple) }}
                tOptions={{ interpolation: { escapeValue: false } }}
                components={{ bdi: <bdi dir="ltr" /> }}
              />
            </Button>
          )}
          {canReplace && (
            <Button size="xs" onClick={onReplace}>
              {t("shortcuts.replace", "Replace")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

type KeycapTone = "normal" | "recording" | "conflict" | "locked";

const KEYCAP_TONE: Readonly<Record<KeycapTone, string | undefined>> = {
  normal: undefined,
  recording: styles.keycapRecording,
  conflict: styles.keycapConflict,
  locked: styles.keycapLocked,
};

/** One chord's keycaps, always left-to-right so the modifier leads in RTL too. */
function Keycaps({
  keys,
  tone = "normal",
}: {
  keys: readonly string[];
  tone?: KeycapTone;
}) {
  return (
    <span className={styles.keycaps} dir="ltr">
      {keys.map((key, i) => (
        <kbd key={i} className={cn(styles.keycap, KEYCAP_TONE[tone])}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

/** A command's chords, with "or" between them. */
function ChordList({
  chords,
  apple,
  tone,
}: {
  chords: readonly string[];
  apple: boolean;
  tone?: KeycapTone;
}) {
  const { t } = useTranslation();
  return (
    <span className={styles.chords}>
      {chords.map((chord, i) => (
        <Fragment key={chord}>
          {i > 0 && <span className={styles.or}>{t("common.or", "or")}</span>}
          <Keycaps keys={shortcutKeycaps(chord, apple)} tone={tone} />
        </Fragment>
      ))}
    </span>
  );
}

/**
 * Why a chord can't be given to this command, or null if it can. A key with
 * no Ctrl, Alt or ⌘ types text everywhere but the calendar, so it would never
 * reach the shortcut; function keys and the Menu key type nothing.
 */
function chordProblem(
  command: ShortcutCommand,
  chord: string,
): "needsModifier" | null {
  if (command.bareKeys) return null;
  const parsed = parseShortcut(chord);
  if (!parsed) return "needsModifier";
  if (parsed.mod || parsed.ctrl || parsed.meta || parsed.alt) return null;
  if (/^f\d{1,2}$/.test(parsed.key) || parsed.key === "contextmenu")
    return null;
  return "needsModifier";
}

/**
 * The ⌘ chord someone on a Mac most likely meant when they pressed ⌃ with the
 * same keys, or null when the chord has no lone ⌃.
 */
function commandKeyGuess(chord: string, apple: boolean): string | null {
  if (!apple) return null;
  const normal = normalizeShortcut(chord, apple);
  return normal?.startsWith("ctrl+")
    ? `mod+${normal.slice("ctrl+".length)}`
    : null;
}

function IconTip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
