import { createContext, useContext, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useOwnPref, useOwnPrefsStore } from "@/app/contexts/OwnPrefsContext";
import { getPlatform } from "@/platform";
import { localFs } from "@/platform/localFs";
import type { FsDriver } from "@/platform/driver";
import {
  BUNDLED_DICTIONARIES,
  preferredLanguages,
  SPELL_WASM_URL,
} from "./dictionaries";
import { SpellService } from "./SpellService";
import {
  platformDictionaryAssets,
  UserDictionaryStore,
} from "./userDictionaries";

/**
 * The legacy import reader is only ever touched by `adopt`, so it can be built
 * around a driver that is still resolving: every call awaits the same promise.
 */
function lazyFs(): FsDriver {
  return {
    read: (path) => localFs().then((fs) => fs.read(path)),
    write: (path, data) => localFs().then((fs) => fs.write(path, data)),
    delete: (path) => localFs().then((fs) => fs.delete(path)),
    list: (dir) => localFs().then((fs) => fs.list(dir)),
    exists: (path) => localFs().then((fs) => fs.exists(path)),
  };
}

/** `localStorage` where this window has one; null in a private window that denies it. */
function browserStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const SpellContext = createContext<SpellService | null>(null);

/**
 * Owns the app's one SpellService. Renders `null` into the context when there
 * is no own-prefs store above it (onboarding), so consumers must handle the
 * absent case.
 */
export function SpellProvider({ children }: { children: React.ReactNode }) {
  const prefs = useOwnPrefsStore();
  // The interface language counts as a language this person reads: someone
  // running the app in English gets the English dictionary even when their
  // browser advertises none of the languages the catalog carries. Changing it
  // reloads the page, so this is read once per service rather than watched.
  const uiLanguage = useTranslation().i18n.resolvedLanguage;
  const service = useMemo(
    () =>
      prefs
        ? new SpellService({
            prefs,
            wasmUrl: SPELL_WASM_URL,
            dictionaries: BUNDLED_DICTIONARIES,
            defaultLanguages: preferredLanguages(
              typeof navigator === "undefined" ? [] : navigator.languages,
              BUNDLED_DICTIONARIES,
              uiLanguage,
            ),
            imported: new UserDictionaryStore({
              prefs,
              assets: platformDictionaryAssets(() => getPlatform()),
              legacy: { fs: lazyFs(), storage: browserStorage() },
            }),
          })
        : null,
    [prefs, uiLanguage],
  );
  useEffect(() => {
    // Children's effects run first and may already have asked for a
    // transport (which activates the service); dispose is reversible, so a
    // StrictMode double-invoke leaves a working service behind.
    service?.activate();
    return () => service?.dispose();
  }, [service]);
  useEffect(() => {
    // Both of these decide what to write by looking at what the register does
    // NOT hold, so both have to wait for the first read to land — otherwise a
    // dictionary added on the laptop is adopted a second time here, and the
    // languages this browser guessed are seeded over the ones already chosen.
    if (!service) return;
    let cancelled = false;
    void service.adoptOnce().then(() => {
      if (!cancelled) void service.seedDefaultLanguages();
    });
    return () => {
      cancelled = true;
    };
  }, [service]);
  return (
    <SpellContext.Provider value={service}>{children}</SpellContext.Provider>
  );
}

/** The app's SpellService, or null where spelling is unavailable. */
export function useSpellService(): SpellService | null {
  return useContext(SpellContext);
}

/** A spelling setting from own-prefs (see `SPELL_PREF_KEYS`), re-rendering on change from any device. */
export function useSpellSetting<T>(key: string, fallback: T) {
  return useOwnPref(key, fallback);
}
