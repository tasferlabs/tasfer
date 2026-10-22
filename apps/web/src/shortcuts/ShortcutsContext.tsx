import {
  isApplePlatform,
  type KeymapOverrides,
  matchesShortcut,
  normalizeShortcut,
  type ShortcutEvent,
} from "@tasfer/editor";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  OWN_PREF_KEYS,
  type OwnPrefsStore,
  useOwnPrefsStore,
} from "@/app/contexts/OwnPrefsContext";
import { detectAdapterDetailed } from "@/platform";
import { shortcutCommands, type ShortcutCommand } from "./commands";

/**
 * The live shortcut table: every command's defaults with this person's changes
 * laid over them. Changes are synced prefs, one key per command
 * (`shortcut.<id>` → the chords, `[]` for none, `null` for back to default), so
 * two devices changing different commands never overwrite each other.
 *
 * One instance per provider, never a module global. Handlers read it at
 * keydown time, so a listener registered once still follows every change.
 */
export class Shortcuts {
  readonly apple: boolean;
  readonly commands: readonly ShortcutCommand[];
  private readonly byId: ReadonlyMap<string, ShortcutCommand>;
  private readonly store: OwnPrefsStore | null;
  // While a chord is being recorded, nothing else answers keys.
  private pauses = 0;

  constructor(store: OwnPrefsStore | null) {
    this.store = store;
    this.apple = isApplePlatform();
    this.commands = shortcutCommands({
      apple: this.apple,
      desktop: detectAdapterDetailed().startsWith("electron"),
    });
    this.byId = new Map(this.commands.map((c) => [c.id, c]));
  }

  command(id: string): ShortcutCommand | undefined {
    return this.byId.get(id);
  }

  /** The chords a command answers now. */
  bindings(id: string): readonly string[] {
    const command = this.byId.get(id);
    if (!command) return [];
    const custom = this.custom(command);
    return custom ?? command.defaults;
  }

  /** Whether the person has changed this command's chords. */
  isChanged(id: string): boolean {
    const command = this.byId.get(id);
    return !!command && this.custom(command) !== null;
  }

  /** Whether this keydown runs the command. Never while recording. */
  matches = (id: string, e: ShortcutEvent): boolean => {
    if (this.pauses > 0) return false;
    return this.bindings(id).some((chord) =>
      matchesShortcut(e, chord, this.apple),
    );
  };

  /** Give a command these chords, synced to this person's other devices. */
  set(id: string, chords: readonly string[]): void {
    const command = this.byId.get(id);
    if (!command || command.locked || !this.store) return;
    const normalized = dedupe(chords, this.apple);
    const same =
      normalized.length === command.defaults.length &&
      normalized.every(
        (c, i) => c === normalizeShortcut(command.defaults[i], this.apple),
      );
    this.store.set(prefKey(id), same ? null : normalized);
  }

  /** Put a command back on its default chords. */
  reset(id: string): void {
    this.store?.set(prefKey(id), null);
  }

  /** Every changed command, back on its defaults. */
  resetAll(): void {
    for (const command of this.commands) {
      if (this.isChanged(command.id)) this.reset(command.id);
    }
  }

  /** The commands other than `exceptId` that answer this chord. */
  conflicts(chord: string, exceptId?: string): ShortcutCommand[] {
    const wanted = normalizeShortcut(chord, this.apple);
    if (!wanted) return [];
    return this.commands.filter(
      (c) =>
        c.id !== exceptId &&
        this.bindings(c.id).some(
          (b) => normalizeShortcut(b, this.apple) === wanted,
        ),
    );
  }

  /** The changes the editor keymap needs (see `editor.setKeymap`). */
  keymapOverrides(): KeymapOverrides {
    const overrides: Record<string, readonly string[]> = {};
    for (const command of this.commands) {
      if (!command.keymapCommand) continue;
      const custom = this.custom(command);
      if (custom) overrides[command.keymapCommand] = custom;
    }
    return overrides as KeymapOverrides;
  }

  /** Stop every shortcut from answering until the returned call. */
  pause(): () => void {
    this.pauses += 1;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.pauses -= 1;
    };
  }

  subscribe = (listener: () => void): (() => void) =>
    this.store?.subscribe(listener) ?? (() => {});

  /** Changes to any binding, for `useSyncExternalStore`. */
  version = (): unknown => this.store?.getSnapshot() ?? null;

  private custom(command: ShortcutCommand): readonly string[] | null {
    if (command.locked || !this.store) return null;
    const stored = this.store.get<unknown>(prefKey(command.id), null);
    if (!Array.isArray(stored)) return null;
    return stored.filter((c): c is string => typeof c === "string");
  }
}

function prefKey(id: string): string {
  return `${OWN_PREF_KEYS.shortcutPrefix}${id}`;
}

function dedupe(chords: readonly string[], apple: boolean): string[] {
  const out: string[] = [];
  for (const chord of chords) {
    const normalized = normalizeShortcut(chord, apple);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

const ShortcutsContext = createContext<Shortcuts | null>(null);

interface ShortcutsDialogState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const ShortcutsDialogContext = createContext<ShortcutsDialogState>({
  open: false,
  setOpen: () => {},
});

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const store = useOwnPrefsStore();
  const shortcuts = useMemo(() => new Shortcuts(store ?? null), [store]);
  const [open, setOpen] = useState(false);
  const dialog = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <ShortcutsContext.Provider value={shortcuts}>
      <ShortcutsDialogContext.Provider value={dialog}>
        {children}
      </ShortcutsDialogContext.Provider>
    </ShortcutsContext.Provider>
  );
}

/**
 * Whether the shortcuts dialog is open, and the way to open it from anywhere —
 * the command palette, Settings. The dialog itself is mounted once by the
 * layout, desktop only.
 */
export function useShortcutsDialog(): ShortcutsDialogState {
  return useContext(ShortcutsDialogContext);
}

/**
 * The shortcut table. Outside a provider (a surface mounted before sign-in,
 * or in its own React root) it answers the defaults.
 */
export function useShortcuts(): Shortcuts {
  const provided = useContext(ShortcutsContext);
  const fallback = useMemo(
    () => (provided ? null : new Shortcuts(null)),
    [provided],
  );
  return provided ?? fallback!;
}

/** The table, re-rendering whenever any binding changes. */
export function useShortcutBindings(): Shortcuts {
  const shortcuts = useShortcuts();
  useSyncExternalStore(shortcuts.subscribe, shortcuts.version);
  return shortcuts;
}

/** The chords one command answers, re-rendering when they change. */
export function useShortcutChords(id: string): readonly string[] {
  return useShortcutBindings().bindings(id);
}

/**
 * Keep an editor's keymap on this person's bindings, live: a change on the
 * Shortcuts tab, or on another device, applies on the next keydown.
 */
export function useLiveKeymap(
  editor: { setKeymap: (overrides: KeymapOverrides) => void } | null,
): void {
  const shortcuts = useShortcuts();
  useEffect(() => {
    if (!editor) return;
    let last = "";
    const push = () => {
      const overrides = shortcuts.keymapOverrides();
      const signature = JSON.stringify(overrides);
      if (signature === last) return;
      last = signature;
      editor.setKeymap(overrides);
    };
    push();
    return shortcuts.subscribe(push);
  }, [editor, shortcuts]);
}
