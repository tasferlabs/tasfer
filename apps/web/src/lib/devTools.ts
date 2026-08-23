/**
 * React bindings for the developer-tools flag, plus the native (desktop) menu
 * sync. The flag itself lives in `devToolsFlag.ts`, which stays React-free so
 * the platform layer can read it outside a UI.
 *
 * Re-exports the flag surface so every existing `@/lib/devTools` import keeps
 * resolving to one module.
 */

import { useSyncExternalStore } from "react";

import {
  DEFAULT_DEV_TOOLS_ENABLED,
  isDevToolsEnabled,
  isDevToolsUnlocked,
  setDevToolsEnabled,
  subscribeDevTools,
} from "./devToolsFlag";

export * from "./devToolsFlag";

/** React binding: re-renders when developer options are unlocked/enabled. */
export function useDevToolsUnlocked(): boolean {
  return useSyncExternalStore(
    subscribeDevTools,
    isDevToolsUnlocked,
    () => DEFAULT_DEV_TOOLS_ENABLED,
  );
}

/** React binding: re-renders when developer tools are toggled. */
export function useDevToolsEnabled(): boolean {
  return useSyncExternalStore(
    subscribeDevTools,
    isDevToolsEnabled,
    () => DEFAULT_DEV_TOOLS_ENABLED,
  );
}

/**
 * Wire the desktop (Electron) app-menu toggle to this flag. The main process
 * pushes a `devtools:set` event over the generic `window.tasfer` IPC whenever
 * the menu item flips; here we mirror it into the flag. No-op off desktop.
 * Idempotent and safe to call once at startup.
 */
export function initNativeDevToolsSync(): void {
  if (typeof window === "undefined") return;
  const desktop = (
    window as unknown as {
      tasfer?: { on?: (channel: string, cb: (value: unknown) => void) => void };
    }
  ).tasfer;
  desktop?.on?.("devtools:set", (value) => {
    if (typeof value === "boolean") setDevToolsEnabled(value);
  });
}
