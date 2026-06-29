/**
 * Developer-tools enablement — the single runtime flag that gates the in-app
 * {@link DevToolbar} (and its network/console capture), replacing the build-time
 * `VITE_STAGING` env gate. No env change is needed to show the toolbar.
 *
 * How it's controlled differs per platform, but they all converge on this flag:
 * - **iOS** — a system **Settings bundle** toggle; the native shell reads its
 *   `UserDefaults` value and injects `window.CypherBridge.devToolsEnabled`.
 * - **Desktop** — a native **app menu** item; the Electron main process persists
 *   the choice, injects `window.cypher.devToolsEnabled` at launch, and pushes
 *   runtime toggles over IPC (see {@link initNativeDevToolsSync}).
 * - **Android / web** — no OS-level control, so an in-app Settings toggle drives
 *   it, persisted in `localStorage`.
 *
 * Precedence: a value injected by a native shell (iOS/desktop) is authoritative
 * and wins; otherwise an explicit in-app choice (`localStorage`) wins; otherwise
 * the staging env seeds the default. The value is cached in-memory and exposed
 * through `useSyncExternalStore`, so the toolbar, the Settings toggle, and the
 * desktop menu stay in lockstep without a context.
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "cypher:devtools-enabled";
const UNLOCK_KEY = "cypher:devtools-unlocked";

/** Default when nothing else specifies a value: on in staging, off otherwise. */
const DEFAULT_ENABLED = import.meta.env.VITE_STAGING === "true";

/**
 * The value a native shell injected at launch, or `undefined` on Android/web.
 * iOS puts it on `window.CypherBridge`; desktop on `window.cypher`.
 */
function readNativeFlag(): boolean | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    CypherBridge?: { devToolsEnabled?: unknown };
    cypher?: { devToolsEnabled?: unknown };
  };
  const value = w.CypherBridge?.devToolsEnabled ?? w.cypher?.devToolsEnabled;
  return typeof value === "boolean" ? value : undefined;
}

/** An explicit in-app choice persisted to `localStorage`, or `undefined`. */
function readStored(): boolean | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // localStorage unavailable (private mode / SSR) — no stored choice.
  }
  return undefined;
}

function resolveInitial(): boolean {
  // A native OS-level setting (iOS Settings bundle, desktop menu) is the source
  // of truth when present; it always wins over a stale in-app choice.
  const native = readNativeFlag();
  if (native !== undefined) return native;
  const stored = readStored();
  if (stored !== undefined) return stored;
  return DEFAULT_ENABLED;
}

let enabled = resolveInitial();

/**
 * Whether the in-app developer-tools setting has been revealed. The Settings
 * toggle lives in the Information tab and is kept low-visibility: it stays hidden
 * until the user "unlocks" developer options (tapping the version number there —
 * see `Information`), the classic Android-style gesture. Persisted across reloads.
 */
let unlocked = (() => {
  try {
    return localStorage.getItem(UNLOCK_KEY) === "true";
  } catch {
    return false;
  }
})();

const listeners = new Set<() => void>();

/** Current enablement — a fast in-memory read (no `localStorage` hit). */
export function isDevToolsEnabled(): boolean {
  return enabled;
}

/**
 * Toggle developer tools and persist the choice. Notifies subscribers. Used by
 * the in-app Settings switch (Android/web) and by the desktop menu sync. The
 * `localStorage` write is harmless on native shells, where the injected value
 * re-asserts authority on the next launch.
 */
export function setDevToolsEnabled(value: boolean): void {
  if (value === enabled) return;
  enabled = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
  } catch {
    // Persisting failed; the in-memory value still drives this session.
  }
  for (const fn of listeners) fn();
}

/** Subscribe to enablement / unlock changes. Returns an unsubscribe function. */
export function subscribeDevTools(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether the in-app developer-tools toggle should be revealed in Settings.
 * True once unlocked, or whenever dev tools are already on / on by default
 * (staging) — so an enabled instance can always be turned back off.
 */
export function isDevToolsUnlocked(): boolean {
  return unlocked || enabled || DEFAULT_ENABLED;
}

/** Reveal the developer-tools toggle (persisted). Notifies subscribers. */
export function unlockDevTools(): void {
  if (unlocked) return;
  unlocked = true;
  try {
    localStorage.setItem(UNLOCK_KEY, "true");
  } catch {
    // Persisting failed; the in-memory unlock still drives this session.
  }
  for (const fn of listeners) fn();
}

/** React binding: re-renders when developer options are unlocked/enabled. */
export function useDevToolsUnlocked(): boolean {
  return useSyncExternalStore(subscribeDevTools, isDevToolsUnlocked, () =>
    DEFAULT_ENABLED,
  );
}

/** React binding: re-renders when developer tools are toggled. */
export function useDevToolsEnabled(): boolean {
  return useSyncExternalStore(subscribeDevTools, isDevToolsEnabled, () =>
    DEFAULT_ENABLED,
  );
}

/**
 * Wire the desktop (Electron) app-menu toggle to this flag. The main process
 * pushes a `devtools:set` event over the generic `window.cypher` IPC whenever
 * the menu item flips; here we mirror it into the flag. No-op off desktop.
 * Idempotent and safe to call once at startup.
 */
export function initNativeDevToolsSync(): void {
  if (typeof window === "undefined") return;
  const desktop = (window as unknown as {
    cypher?: { on?: (channel: string, cb: (value: unknown) => void) => void };
  }).cypher;
  desktop?.on?.("devtools:set", (value) => {
    if (typeof value === "boolean") setDevToolsEnabled(value);
  });
}
