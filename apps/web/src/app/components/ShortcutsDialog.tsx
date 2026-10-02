import {
  normalizeShortcut,
  parseShortcut,
  shortcutFromEvent,
} from "@tasfer/editor";
import {
  Keyboard,
  Lock,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmation } from "@/app/components/ConfirmationDialog";
import { ShortcutKeys } from "@/app/components/ShortcutKeys";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  scopeLabel,
  type ShortcutCommand,
  type ShortcutScope,
} from "@/shortcuts/commands";
import { shortcutKeycaps, shortcutText } from "@/shortcuts/keycaps";
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

/** A row being given new keys: replacing its chords, or adding one more. */
interface Editing {
  id: string;
  mode: "replace" | "add";
}

/**
 * Every shortcut in one searchable grid, VS Code's keybindings editor in the
 * app's own clothes. A row is changed by pressing the new keys; changes sync to
 * the person's other devices. Opened from the command palette and Settings →
 * Preferences. Desktop only: a phone has no keyboard to set shortcuts for, so
 * the host leaves it unmounted there.
 */
export function ShortcutsDialog() {
  const { t } = useTranslation();
  const { open, setOpen } = useShortcutsDialog();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className={styles.dialog}>
        <div className={styles.header}>
          <div className={styles.heading}>
            <DialogTitle>
              {t("shortcuts.title", "Keyboard shortcuts")}
            </DialogTitle>
            <DialogDescription className={styles.description}>
              {t(
                "shortcuts.description",
                "Every shortcut in Tasfer, in one place. Search them, and change the ones you use — your changes follow you to your other devices.",
              )}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("common.close", "Close")}
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </div>
        {/* Content unmounts on close, so every opening starts fresh. */}
        <ShortcutsPanel />
      </DialogContent>
    </Dialog>
  );
}

function ShortcutsPanel() {
  const { t, i18n } = useTranslation();
  const shortcuts = useShortcutBindings();
  const { getConfirmation } = useConfirmation();
  const [query, setQuery] = useState("");
  // Search by pressing the keys rather than typing their names.
  const [recordSearch, setRecordSearch] = useState(false);
  const [searchChord, setSearchChord] = useState<string | null>(null);
  const [changedOnly, setChangedOnly] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const changedCount = shortcuts.commands.filter((c) =>
    shortcuts.isChanged(c.id),
  ).length;

  const rows = (() => {
    const needle = query.trim().toLowerCase();
    const wanted = searchChord
      ? normalizeShortcut(searchChord, shortcuts.apple)
      : null;
    return shortcuts.commands
      .filter((command) => {
        if (changedOnly && !shortcuts.isChanged(command.id)) return false;
        const chords = shortcuts.bindings(command.id);
        if (recordSearch) {
          return (
            !wanted ||
            chords.some((c) => normalizeShortcut(c, shortcuts.apple) === wanted)
          );
        }
        if (!needle) return true;
        const haystack = [
          command.label(t),
          scopeLabel(command.scope, t),
          ...chords,
          ...chords.map((c) => shortcutText(c, shortcuts.apple)),
          ...chords.map((c) => shortcutKeycaps(c, shortcuts.apple).join(" ")),
        ]
          .join("\n")
          .toLowerCase();
        return haystack.includes(needle);
      })
      .sort(
        (a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope),
      );
  })();

  // While recording a search chord, the app's own shortcuts stand down, or
  // ⌘K would open the palette instead of being searched for.
  useEffect(() => {
    if (!recordSearch) return;
    const input = searchRef.current;
    if (!input) return;
    let resume: (() => void) | null = null;
    const onFocus = () => {
      resume ??= shortcuts.pause();
    };
    const onBlur = () => {
      resume?.();
      resume = null;
    };
    input.addEventListener("focus", onFocus);
    input.addEventListener("blur", onBlur);
    if (document.activeElement === input) onFocus();
    return () => {
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("blur", onBlur);
      onBlur();
    };
  }, [recordSearch, shortcuts]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!recordSearch) return;
    // Tab still leaves the field, so the keyboard is never trapped in it.
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const chord = shortcutFromEvent(e.nativeEvent, shortcuts.apple);
    if (chord) setSearchChord(chord);
  };

  const toggleRecordSearch = () => {
    setRecordSearch((on) => !on);
    setSearchChord(null);
    setQuery("");
    searchRef.current?.focus();
  };

  const resetAll = async () => {
    const confirmed = await getConfirmation({
      title: t("shortcuts.resetAllTitle", "Reset all shortcuts?"),
      description: t(
        "shortcuts.resetAllDescription",
        "Every shortcut you changed goes back to its default, on all your devices.",
      ),
      confirmText: t("shortcuts.resetAll", "Reset all"),
    });
    if (confirmed) shortcuts.resetAll();
  };

  const listFormat = useMemo(
    () => new Intl.ListFormat(i18n.language, { type: "conjunction" }),
    [i18n.language],
  );

  return (
    <>
      <div className={styles.toolbar}>
        <div
          className={cn(styles.search, recordSearch && styles.searchRecording)}
        >
          <Search size={16} className={styles.searchIcon} aria-hidden />
          {recordSearch && searchChord ? (
            <ShortcutKeys
              keys={shortcutKeycaps(searchChord, shortcuts.apple)}
              className={styles.searchChord}
            />
          ) : null}
          <input
            ref={searchRef}
            type="search"
            className={styles.searchInput}
            value={recordSearch ? "" : query}
            readOnly={recordSearch}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={
              recordSearch
                ? searchChord
                  ? ""
                  : t(
                      "shortcuts.recordSearchPlaceholder",
                      "Press keys to search…",
                    )
                : t("shortcuts.searchPlaceholder", "Search by name or keys")
            }
            aria-label={t("shortcuts.searchLabel", "Search shortcuts")}
          />
          <IconTip
            label={t("shortcuts.recordSearch", "Search by pressing keys")}
          >
            <Button
              variant="ghost"
              size="icon-xs"
              aria-pressed={recordSearch}
              aria-label={t(
                "shortcuts.recordSearch",
                "Search by pressing keys",
              )}
              className={cn(
                styles.recordToggle,
                recordSearch && styles.recordToggleOn,
              )}
              onClick={toggleRecordSearch}
            >
              <Keyboard />
            </Button>
          </IconTip>
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={changedOnly}
          className={cn(changedOnly && styles.filterOn)}
          onClick={() => setChangedOnly((on) => !on)}
        >
          {t("shortcuts.changedOnly", "Changed")}
          <span className={styles.count}>{changedCount}</span>
        </Button>
        {changedCount > 0 && (
          <Button variant="ghost" size="sm" onClick={resetAll}>
            <RotateCcw />
            {t("shortcuts.resetAll", "Reset all")}
          </Button>
        )}
      </div>

      <div className={styles.body}>
        <div className={styles.frame}>
          <table className={styles.grid}>
            <thead>
              <tr>
                <th scope="col" className={styles.colCommand}>
                  {t("shortcuts.column.command", "Command")}
                </th>
                <th scope="col" className={styles.colKeys}>
                  {t("shortcuts.column.keys", "Shortcut")}
                </th>
                <th scope="col" className={styles.colScope}>
                  {t("shortcuts.column.where", "Where")}
                </th>
                <th scope="col" className={styles.colActions}>
                  <span className="sr-only">
                    {t("shortcuts.column.actions", "Actions")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((command) => (
                <ShortcutRow
                  key={command.id}
                  command={command}
                  shortcuts={shortcuts}
                  editing={editing?.id === command.id ? editing.mode : null}
                  onEdit={(mode) => setEditing({ id: command.id, mode })}
                  onDone={() => setEditing(null)}
                  listFormat={listFormat}
                />
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className={styles.empty}>
              {changedOnly && changedCount === 0
                ? t(
                    "shortcuts.noneChanged",
                    "You haven’t changed any shortcuts.",
                  )
                : t("shortcuts.noResults", "No shortcuts match your search.")}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function ShortcutRow({
  command,
  shortcuts,
  editing,
  onEdit,
  onDone,
  listFormat,
}: {
  command: ShortcutCommand;
  shortcuts: ShortcutTable;
  editing: Editing["mode"] | null;
  onEdit: (mode: Editing["mode"]) => void;
  onDone: () => void;
  listFormat: Intl.ListFormat;
}) {
  const { t } = useTranslation();
  const label = command.label(t);
  const chords = shortcuts.bindings(command.id);
  const changed = shortcuts.isChanged(command.id);

  return (
    <tr
      className={cn(
        styles.row,
        command.locked && styles.rowLocked,
        editing && styles.rowEditing,
      )}
      onDoubleClick={() => !command.locked && !editing && onEdit("replace")}
    >
      <td className={styles.colCommand}>
        <span className={styles.label}>{label}</span>
        {changed && (
          <span className={styles.changedBadge}>
            {t("shortcuts.changedBadge", "Changed")}
          </span>
        )}
      </td>
      <td className={styles.colKeys}>
        {editing ? (
          <Recorder
            command={command}
            shortcuts={shortcuts}
            mode={editing}
            onDone={onDone}
            listFormat={listFormat}
          />
        ) : chords.length > 0 ? (
          <span className={styles.chords}>
            {chords.map((chord, i) => (
              <Fragment key={chord}>
                {i > 0 && (
                  <span className={styles.or}>{t("common.or", "or")}</span>
                )}
                <ShortcutKeys keys={shortcutKeycaps(chord, shortcuts.apple)} />
              </Fragment>
            ))}
          </span>
        ) : (
          <span className={styles.unset}>
            {t("shortcuts.notSet", "Not set")}
          </span>
        )}
      </td>
      <td className={styles.colScope}>{scopeLabel(command.scope, t)}</td>
      <td className={styles.colActions}>
        {command.locked ? (
          <IconTip label={t("shortcuts.locked", "Built in — can’t be changed")}>
            <span
              className={styles.lock}
              tabIndex={0}
              aria-label={t("shortcuts.locked", "Built in — can’t be changed")}
            >
              <Lock size={14} />
            </span>
          </IconTip>
        ) : editing ? null : (
          <div className={styles.actions}>
            <IconTip label={t("shortcuts.change", "Change shortcut")}>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t(
                  "shortcuts.changeFor",
                  "Change shortcut for {{command}}",
                  { command: label, interpolation: { escapeValue: false } },
                )}
                onClick={() => onEdit("replace")}
              >
                <Pencil />
              </Button>
            </IconTip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("shortcuts.moreFor", "More for {{command}}", {
                    command: label,
                    interpolation: { escapeValue: false },
                  })}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onEdit("add")}>
                  {t("shortcuts.addAnother", "Add another shortcut")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={chords.length === 0}
                  onSelect={() => shortcuts.set(command.id, [])}
                >
                  {t("shortcuts.remove", "Remove shortcut")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!changed}
                  onSelect={() => shortcuts.reset(command.id)}
                >
                  {t("shortcuts.reset", "Reset to default")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * The shortcut cell while it listens for new keys. Every key goes to it: the
 * app's shortcuts stand down until it closes. Enter saves, Escape cancels.
 */
function Recorder({
  command,
  shortcuts,
  mode,
  onDone,
  listFormat,
}: {
  command: ShortcutCommand;
  shortcuts: ShortcutTable;
  mode: Editing["mode"];
  onDone: () => void;
  listFormat: Intl.ListFormat;
}) {
  const { t, i18n } = useTranslation();
  const [chord, setChord] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const problem = chord ? chordProblem(command, chord) : null;
  const conflicts = chord ? shortcuts.conflicts(chord, command.id) : [];

  const save = () => {
    if (!chord || problem) return;
    const existing = shortcuts.bindings(command.id);
    shortcuts.set(command.id, mode === "add" ? [...existing, chord] : [chord]);
    onDone();
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  // The parent hands a fresh callback each render; the listener below must
  // not re-attach (and re-focus) every time it does.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    boxRef.current?.focus();
    const resume = shortcuts.pause();
    const onKeyDown = (e: KeyboardEvent) => {
      const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      // Tab moves on to the Save and Cancel buttons, as it does anywhere.
      if (bare && e.key === "Tab") return;
      // A button in the recorder answers its own Enter and Space.
      if (
        bare &&
        (e.key === "Enter" || e.key === " ") &&
        e.target instanceof HTMLButtonElement
      ) {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (bare && e.key === "Escape") {
        doneRef.current();
        return;
      }
      if (bare && e.key === "Enter") {
        saveRef.current();
        return;
      }
      const next = shortcutFromEvent(e, shortcuts.apple);
      if (next) setChord(next);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      resume();
    };
  }, [shortcuts]);

  const conflictNames = listFormat.format(conflicts.map((c) => c.label(t)));
  const modifiers = new Intl.ListFormat(i18n.language, {
    type: "disjunction",
  }).format(shortcuts.apple ? ["⌘", "⌥", "⌃"] : ["Ctrl", "Alt"]);

  return (
    <div className={styles.recorder}>
      <div
        ref={boxRef}
        tabIndex={-1}
        className={cn(styles.recordBox, problem && styles.recordBoxInvalid)}
        role="status"
        aria-live="polite"
        onBlur={(e) => {
          // Clicking away cancels, as Escape does — but not a click on the
          // recorder's own buttons.
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) {
            onDone();
          }
        }}
      >
        {chord ? (
          <ShortcutKeys keys={shortcutKeycaps(chord, shortcuts.apple)} />
        ) : (
          <span className={styles.recordPrompt}>
            {mode === "add"
              ? t("shortcuts.recordPromptAdd", "Press the keys to add…")
              : t("shortcuts.recordPrompt", "Press the new keys…")}
          </span>
        )}
      </div>
      {/* Pressing a button must not blur the box first: Safari gives a
          clicked button no focus, so the blur would read as clicking away. */}
      <div
        className={styles.recordButtons}
        onMouseDown={(e) => e.preventDefault()}
      >
        <Button size="xs" disabled={!chord || !!problem} onClick={save}>
          {t("common.save", "Save")}
        </Button>
        <Button size="xs" variant="ghost" onClick={onDone}>
          {t("common.cancel", "Cancel")}
        </Button>
      </div>
      {problem === "needsModifier" ? (
        <p className={cn(styles.recordNote, styles.recordNoteError)}>
          {t(
            "shortcuts.needsModifier",
            "Add {{modifiers}} — on its own, this key types text.",
            { modifiers, interpolation: { escapeValue: false } },
          )}
        </p>
      ) : conflicts.length > 0 ? (
        <p className={cn(styles.recordNote, styles.recordNoteWarn)}>
          <TriangleAlert size={14} aria-hidden />
          {t("shortcuts.conflict", "Also used by {{commands}}.", {
            commands: conflictNames,
            interpolation: { escapeValue: false },
          })}
        </p>
      ) : (
        <p className={styles.recordNote}>
          {t("shortcuts.recordHint", "Enter to save, Esc to cancel.")}
        </p>
      )}
    </div>
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
