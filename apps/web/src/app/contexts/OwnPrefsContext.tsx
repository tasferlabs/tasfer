import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { getPlatform } from "@/platform";
import {
  LEGACY_PARENT_USAGE_KEY,
  readLegacyParentUsage,
} from "@/lib/parentUsage";
import { LEGACY_FRECENCY_KEY, readLegacyFrecency } from "@/lib/paletteUsage";
import {
  LEGACY_RECENT_ZONES_KEY,
  readLegacyRecentZones,
} from "@/components/timezonepicker/timezoneData";

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
  /**
   * `string[]` — dictionary ids to check against. Absent until the first run
   * seeds it with the bundled dictionaries this device's languages match
   * (`en`, `ar`, or both); see `preferredLanguages`.
   */
  spellLanguages: "spell.languages",
  /** `boolean` — accept common Arabic orthographic variants (hamza, ة/ه, ى/ي). */
  spellLenientArabic: "spell.lenientArabic",
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
  /**
   * Key PREFIX: `spell.dict.<id>` → the descriptor of a dictionary the person
   * added from a file (see `SyncedDictionary` in `src/spell/userDictionaries.ts`).
   * One key per dictionary, and removal writes `null`, for the same reason the
   * word list does it: the register cannot delete and cannot merge a list.
   *
   * The descriptor holds content hashes, never bytes — the files themselves go
   * into the shared asset store and are pulled by hash from whichever of this
   * person's devices has them. A pref is re-sent on every handshake, so a
   * megabyte of base64 here would cross the wire on every reconnection.
   */
  spellDictPrefix: "spell.dict.",
  /**
   * The Date & Time settings, one key each — how a clock and a date read, and
   * which day starts the week. A person's reading of "14:30" does not change
   * with the machine they are on, so these follow them; where they physically
   * are can, which is why `dateTime.timezone` holds "system" (resolve against
   * this device) until they pin a zone on purpose.
   *
   * `"12h" | "24h" | "system"`.
   */
  dateTimeTimeFormat: "dateTime.timeFormat",
  /** `"MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD" | "system"`. */
  dateTimeDateFormat: "dateTime.dateFormat",
  /** `0 | 1 | 6` — Sunday, Monday, or Saturday. */
  dateTimeWeekStart: "dateTime.weekStart",
  /** An IANA zone id, or "system" to follow whichever device is reading. */
  dateTimeTimezone: "dateTime.timezone",
  /**
   * Key PREFIX: `calendar.parentUsage.<spaceId>.<deviceKey>` → which pages
   * that device files events under in that space (see `@/lib/parentUsage`).
   * Every device's tally is added together to feed the event draft's "Recent"
   * row and its pre-filled parent. One key per device because a tally is the
   * one thing last-writer-wins gets wrong: two devices counting at once would
   * each overwrite the other's counts (see `@/lib/deviceTally`). Mirrored as
   * `PARENT_USAGE_PREF_PREFIX` there.
   */
  calendarParentUsagePrefix: "calendar.parentUsage.",
  /** `boolean` — the draft parent picker's "Recent" row; absent means open. */
  calendarRecentParentsOpen: "calendar.recentParentsOpen",
  /** `boolean` — the draft parent picker's page tree; absent means open. */
  calendarParentTreeOpen: "calendar.parentTreeOpen",
  /** `string` — the space a new calendar event is drafted into. */
  calendarEventSpace: "calendar.eventSpace",
  /**
   * Key PREFIX: `palette.usage.<deviceKey>` → how often and how lately that
   * device picked each command palette item, for ranking. Per device for the
   * same reason as the parent usage. Mirrored as `PALETTE_USAGE_PREF_PREFIX`
   * in `@/lib/paletteUsage`.
   */
  paletteUsagePrefix: "palette.usage.",
  /**
   * Key PREFIX: `timezone.recents.<deviceKey>` → the zones that device picked
   * lately; the timezone picker offers the latest few across all devices.
   * Mirrored as `RECENT_ZONES_PREF_PREFIX` in the timezone picker's data.
   */
  timezoneRecentsPrefix: "timezone.recents.",
} as const;

/**
 * Values these preferences used to be kept in, per browser. Adopted into the
 * register on first run and then dropped — see `platform.prefs.seed` for why the
 * adopted value is stamped to lose to any dated decision.
 */
const LEGACY: Array<{
  storageKey: string;
  /** Adopt every browser key starting with `storageKey`, not just that one. */
  prefix?: boolean;
  /**
   * Returns the entries to seed, or nothing if the legacy value is unusable.
   * Throws to leave the value in place for the next launch.
   */
  read: (raw: string, ctx: LegacyContext) => Array<[string, unknown]>;
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
  // The Date & Time tab wrote each of these as its own browser key. A value
  // equal to the default is not adopted: "system" and Monday are what an unset
  // key already means, and seeding them would turn this browser's silence into
  // an answer that a real choice made on another device has to outrank.
  {
    storageKey: "timeFormat",
    read: (raw) =>
      raw === "12h" || raw === "24h"
        ? [[OWN_PREF_KEYS.dateTimeTimeFormat, raw]]
        : [],
  },
  {
    storageKey: "dateFormat",
    read: (raw) =>
      raw === "MM/DD/YYYY" || raw === "DD/MM/YYYY" || raw === "YYYY-MM-DD"
        ? [[OWN_PREF_KEYS.dateTimeDateFormat, raw]]
        : [],
  },
  {
    storageKey: "weekStart",
    read: (raw) =>
      raw === "0" || raw === "6"
        ? [[OWN_PREF_KEYS.dateTimeWeekStart, Number(raw)]]
        : [],
  },
  {
    storageKey: "timezone",
    // Only ever written when the person pinned a zone; "system" was stored by
    // removing the key.
    read: (raw) =>
      raw && raw !== "system" ? [[OWN_PREF_KEYS.dateTimeTimezone, raw]] : [],
  },
  // The event draft's parent picker kept its shortcut stats, its two folds and
  // the draft's space in this browser alone.
  {
    storageKey: LEGACY_PARENT_USAGE_KEY,
    read: (raw, ctx) => readLegacyParentUsage(raw, requireDevice(ctx)),
  },
  {
    storageKey: "tasfer:remember:event-space",
    read: (raw) => (raw ? [[OWN_PREF_KEYS.calendarEventSpace, raw]] : []),
  },
  {
    storageKey: "tasfer:remember:calendar-recent-parents",
    read: (raw) =>
      raw === "open" || raw === "closed"
        ? [[OWN_PREF_KEYS.calendarRecentParentsOpen, raw === "open"]]
        : [],
  },
  {
    storageKey: "tasfer:remember:calendar-parent-tree",
    read: (raw) =>
      raw === "open" || raw === "closed"
        ? [[OWN_PREF_KEYS.calendarParentTreeOpen, raw === "open"]]
        : [],
  },
  {
    storageKey: LEGACY_FRECENCY_KEY,
    read: (raw, ctx) => readLegacyFrecency(raw, requireDevice(ctx)),
  },
  {
    storageKey: LEGACY_RECENT_ZONES_KEY,
    read: (raw, ctx) => readLegacyRecentZones(raw, requireDevice(ctx)),
  },
];

interface LegacyContext {
  /** This device's key, or null if it could not be read. */
  deviceKey: string | null;
  /** The browser key the value came from (useful for prefix entries). */
  storageKey: string;
}

/**
 * A per-device key cannot be named without this device's key. Throwing leaves
 * the legacy value in place, so the next launch can try again.
 */
function requireDevice(ctx: LegacyContext): string {
  if (!ctx.deviceKey) throw new Error("device key unavailable");
  return ctx.deviceKey;
}

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
  private device: string | null = null;

  /**
   * This device's public key, once `hydrate` has read it — the suffix of the
   * keys only this device writes (see `@/lib/deviceTally`). Null before then.
   */
  get deviceKey(): string | null {
    return this.device;
  }

  /**
   * Every set value whose key starts with `prefix`, as `[key, value]` pairs.
   * Keys holding `null` (a removed entry) are left out.
   */
  entries(prefix: string): Array<[string, unknown]> {
    const found: Array<[string, unknown]> = [];
    for (const [key, value] of Object.entries(this.snapshot.values)) {
      if (key.startsWith(prefix) && value !== null && value !== undefined) {
        found.push([key, value]);
      }
    }
    return found;
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  /**
   * Resolves once the first read from the database has landed.
   *
   * Anything that decides what to write by noticing a key is *absent* has to
   * wait for this: before it, every key looks absent, and "nobody has chosen
   * yet" is indistinguishable from "the answer has not arrived".
   */
  whenLoaded(): Promise<void> {
    if (this.snapshot.loaded) return Promise.resolve();
    return new Promise((resolve) => {
      const stop = this.subscribe(() => {
        if (!this.snapshot.loaded) return;
        stop();
        resolve();
      });
    });
  }

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
      this.commit(
        { ...this.snapshot.values, ...changed },
        this.snapshot.loaded,
      );
    });

    // Read side by side: neither waits on the other, and every own-pref
    // reads as its fallback until both are in.
    const [identity, stored] = await Promise.allSettled([
      platform.identity.get(),
      platform.prefs.getAll(),
    ]);
    if (identity.status === "fulfilled") {
      this.device = identity.value.publicKey;
    } else {
      console.warn(
        "[OwnPrefs] could not read this device's key:",
        identity.reason,
      );
    }
    let values: Record<string, unknown> = {};
    try {
      if (stored.status === "rejected") throw stored.reason;
      values = await this.adoptLegacy(stored.value);
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

  /**
   * Record a value the person never actually chose — a default this device
   * worked out for itself — so their other devices inherit it instead of each
   * working out its own.
   *
   * Stamped to lose to any real decision, including one already made elsewhere
   * and still in flight (see `platform.prefs.seed`), and a no-op once the key
   * has any answer at all. Resolves to whether this device's guess is the one
   * that stuck.
   */
  async seed(key: string, value: unknown): Promise<boolean> {
    try {
      const took = await getPlatform().prefs.seed(key, value);
      if (took) {
        this.commit(
          { ...this.snapshot.values, [key]: value },
          this.snapshot.loaded,
        );
      }
      return took;
    } catch (err) {
      console.warn(`[OwnPrefs] could not seed ${key}:`, err);
      return false;
    }
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
      let storageKeys: string[];
      try {
        storageKeys = legacy.prefix
          ? Object.keys(localStorage).filter((k) =>
              k.startsWith(legacy.storageKey),
            )
          : [legacy.storageKey];
      } catch {
        return adopted; // Storage unavailable (private mode) — nothing to adopt.
      }

      for (const storageKey of storageKeys) {
        let raw: string | null = null;
        try {
          raw = localStorage.getItem(storageKey);
        } catch {
          return adopted; // Storage unavailable (private mode) — nothing to adopt.
        }
        if (raw === null) continue;

        try {
          const ctx = { deviceKey: this.device, storageKey };
          // Seeded together: one old list can hold a few hundred words.
          const seeds = legacy
            .read(raw, ctx)
            .filter(([key]) => !(key in adopted));
          const took = await Promise.all(
            seeds.map(([key, value]) => platform.prefs.seed(key, value)),
          );
          seeds.forEach(([key, value], i) => {
            if (took[i]) adopted[key] = value;
          });
        } catch (err) {
          // Left in place for the next launch. A seed that failed (worker
          // restarting, storage error) recorded no answer anywhere, so dropping
          // the copy now would lose the value outright rather than retry it.
          console.warn(`[OwnPrefs] could not adopt ${storageKey}:`, err);
          continue;
        }
        // Dropped whether or not it was adopted: if the register already held
        // an answer for the key, this copy is a stale duplicate of a question
        // that now has one place to live.
        try {
          localStorage.removeItem(storageKey);
        } catch {
          // Nothing to do; the seed is a no-op next time round.
        }
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
