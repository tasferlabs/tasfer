import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { getPlatform } from "@/platform";

/**
 * Person-private preferences — the app-layer view of `platform.prefs`.
 *
 * These are the choices that follow the person rather than the machine: how the
 * sidebar is arranged, which walkthroughs have been read. They live in the
 * database and replicate to this person's other devices (never to a co-member),
 * so arranging the sidebar on a laptop arranges it on the phone.
 *
 * What does NOT belong here is anything genuinely about one machine — the theme,
 * the last route, which banner this browser dismissed. Those stay in
 * `localStorage`, where a phone and a laptop can disagree on purpose.
 *
 * The store keeps one in-memory snapshot so components read synchronously; the
 * database is the source of truth and every write goes to it.
 */

export const OWN_PREF_KEYS = {
  /** `string[]` — space ids in sidebar order. Unlisted spaces sort after. */
  spaceOrder: "sidebar.spaceOrder",
  /** `string[]` — space ids whose sidebar section is collapsed. */
  spacesCollapsed: "sidebar.spacesCollapsed",
  /** `true` once the person has read the P2P sharing walkthrough. */
  p2pTutorialSeen: "tutorial.p2pSeen",
  /** `boolean` — spellcheck on or off; absent means on. */
  spellEnabled: "spell.enabled",
  /** `string[]` — dictionary ids to check against; absent means `["en", "ar"]`. */
  spellLanguages: "spell.languages",
  /** `boolean` — accept common Arabic orthographic variants (hamza, ة/ه, ى/ي). */
  spellLenientArabic: "spell.lenientArabic",
  /** `boolean` — flag ALL-CAPS Latin words instead of treating them as acronyms. */
  spellFlagAllCaps: "spell.flagAllCaps",
  /** `boolean` — stronger squiggle colours. */
  spellHighContrast: "spell.highContrast",
  /**
   * Key PREFIX, not a key: `spell.word.<word>` → `{ added: ms }` for every word
   * in the personal dictionary. One key per word because the register is
   * last-writer-wins per key and cannot delete: a single list would let two
   * devices overwrite each other's additions and could never shrink. Removal
   * writes `null`, which `get` reads as absent. Mirrored as `SPELL_PREF_KEYS`
   * in `src/spell/personalDictionary.ts`.
   */
  spellWordPrefix: "spell.word.",
  /** Key PREFIX: `spell.forbid.<word>` → `{ added: ms }` — words to always flag. */
  spellForbidPrefix: "spell.forbid.",
} as const;

/**
 * Values these preferences used to be kept in, per browser. Adopted into the
 * register on first run and then dropped — see `platform.prefs.seed` for why the
 * adopted value is stamped to lose to any dated decision.
 */
const LEGACY: Array<{
  storageKey: string;
  /** Returns the entries to seed, or nothing if the legacy value is unusable. */
  read: (raw: string) => Array<[string, unknown]>;
}> = [
  {
    storageKey: "tasfer.spacePrefs",
    read: (raw) => {
      const parsed = JSON.parse(raw) as {
        order?: unknown;
        collapsed?: unknown;
      };
      const entries: Array<[string, unknown]> = [];
      if (Array.isArray(parsed.order) && parsed.order.length > 0) {
        entries.push([OWN_PREF_KEYS.spaceOrder, parsed.order]);
      }
      if (Array.isArray(parsed.collapsed) && parsed.collapsed.length > 0) {
        entries.push([OWN_PREF_KEYS.spacesCollapsed, parsed.collapsed]);
      }
      return entries;
    },
  },
  {
    storageKey: "tasfer:p2p-tutorial-seen",
    read: (raw) =>
      raw === "1" ? [[OWN_PREF_KEYS.p2pTutorialSeen, true]] : [],
  },
];

interface Snapshot {
  values: Record<string, unknown>;
  /** False until the first read from the database lands. */
  loaded: boolean;
}

type Listener = () => void;

export class OwnPrefsStore {
  private snapshot: Snapshot = { values: {}, loaded: false };
  private listeners = new Set<Listener>();
  private unsubscribe?: () => void;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  /**
   * Read the register, adopting any leftover browser-stored values first.
   *
   * The change subscription opens before the read, and anything it delivers
   * wins over the read's result: an event is always about a moment later than
   * the one the read describes.
   */
  async hydrate(): Promise<void> {
    const platform = getPlatform();
    this.unsubscribe = platform.prefs.onChange((changed) => {
      this.commit({ ...this.snapshot.values, ...changed }, this.snapshot.loaded);
    });

    let values: Record<string, unknown> = {};
    try {
      values = await platform.prefs.getAll();
      values = await this.adoptLegacy(values);
    } catch (err) {
      console.warn("[OwnPrefs] could not read preferences:", err);
    }
    this.commit({ ...values, ...this.snapshot.values }, true);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  get<T>(key: string, fallback: T): T {
    const value = this.snapshot.values[key];
    return value === undefined || value === null ? fallback : (value as T);
  }

  /** Record a decision and let it propagate to this person's other devices. */
  set(key: string, value: unknown): void {
    // Applied locally first: the sidebar should move with the drag, not with
    // the round-trip to the engine.
    this.commit(
      { ...this.snapshot.values, [key]: value },
      this.snapshot.loaded,
    );
    void getPlatform()
      .prefs.set(key, value)
      .catch((err) => console.warn(`[OwnPrefs] could not save ${key}:`, err));
  }

  private async adoptLegacy(
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (typeof localStorage === "undefined") return values;
    const platform = getPlatform();
    const adopted = { ...values };

    for (const legacy of LEGACY) {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(legacy.storageKey);
      } catch {
        return adopted; // Storage unavailable (private mode) — nothing to adopt.
      }
      if (raw === null) continue;

      try {
        for (const [key, value] of legacy.read(raw)) {
          if (key in adopted) continue;
          if (await platform.prefs.seed(key, value)) adopted[key] = value;
        }
      } catch (err) {
        // Left in place for the next launch. A seed that failed (worker
        // restarting, storage error) recorded no answer anywhere, so dropping
        // the copy now would lose the value outright rather than retry it.
        console.warn(`[OwnPrefs] could not adopt ${legacy.storageKey}:`, err);
        continue;
      }
      // Dropped whether or not it was adopted: if the register already held an
      // answer for the key, this copy is a stale duplicate of a question that
      // now has one place to live.
      try {
        localStorage.removeItem(legacy.storageKey);
      } catch {
        // Nothing to do; the seed is a no-op next time round.
      }
    }
    return adopted;
  }

  private commit(values: Record<string, unknown>, loaded: boolean) {
    this.snapshot = { values, loaded };
    for (const l of this.listeners) l();
  }
}

const OwnPrefsContext = createContext<OwnPrefsStore>(null!);

export function OwnPrefsProvider({ children }: { children: React.ReactNode }) {
  const store = useMemo(() => new OwnPrefsStore(), []);
  useEffect(() => {
    void store.hydrate();
    return () => store.dispose();
  }, [store]);
  return (
    <OwnPrefsContext.Provider value={store}>
      {children}
    </OwnPrefsContext.Provider>
  );
}

export function useOwnPrefsStore() {
  return useContext(OwnPrefsContext);
}

/**
 * Read one preference, re-rendering when any of this person's devices changes
 * it. `loaded` is false until the first database read lands — gate on it before
 * acting on an *absent* value, or a walkthrough already read will run again in
 * the moment before the register arrives.
 */
export function useOwnPref<T>(
  key: string,
  fallback: T,
): { value: T; loaded: boolean; set: (next: T) => void } {
  const store = useContext(OwnPrefsContext);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const value = store.get(key, fallback);
  return useMemo(
    () => ({
      value,
      loaded: snapshot.loaded,
      set: (next: T) => store.set(key, next),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, value, snapshot.loaded, store],
  );
}
