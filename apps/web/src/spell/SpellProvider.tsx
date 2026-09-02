import { createContext, useContext, useEffect, useMemo } from "react";
import { useOwnPref, useOwnPrefsStore } from "@/app/contexts/OwnPrefsContext";
import { BUNDLED_DICTIONARIES, SPELL_WASM_URL } from "./dictionaries";
import { SpellService } from "./SpellService";

const SpellContext = createContext<SpellService | null>(null);

/**
 * Owns the app's one SpellService. Renders `null` into the context when there
 * is no own-prefs store above it (onboarding), so consumers must handle the
 * absent case.
 */
export function SpellProvider({ children }: { children: React.ReactNode }) {
  const prefs = useOwnPrefsStore();
  const service = useMemo(
    () =>
      prefs
        ? new SpellService({
            prefs,
            wasmUrl: SPELL_WASM_URL,
            dictionaries: BUNDLED_DICTIONARIES,
          })
        : null,
    [prefs],
  );
  useEffect(() => {
    // Children's effects run first and may already have asked for a
    // transport (which activates the service); dispose is reversible, so a
    // StrictMode double-invoke leaves a working service behind.
    service?.activate();
    return () => service?.dispose();
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
