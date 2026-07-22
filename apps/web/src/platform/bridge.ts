/**
 * Native Bridge — TasferBridge
 *
 * Both iOS and Android inject `window.TasferBridge` with the same method
 * shape; all methods return Promises so consumers never need platform
 * branching. (Data properties may be platform-specific — see `app`.)
 *
 * Editor callbacks (undo, redo, toggleStrong, etc.) live on a separate
 * `window.TasferEditorCallbacks` object that the web app assigns and
 * native code calls via evaluateJavaScript.
 */

// =============================================================================
// Bridge types
// =============================================================================

/**
 * Serializable context-menu item posted to the native shell. Mirror of the
 * host's `ContextMenuItem` minus the React icon node and action callback (built
 * in `app/nativeContextMenu.ts`). `id` is the join key the native side echoes
 * back so the host can run the matching action.
 */
export interface NativeMenuItem {
  id: string;
  label: string;
  /** SF Symbol name for iOS, which renders its own template icon. */
  icon?: string;
  /**
   * Pre-rasterized, theme-colored PNG data URL for hosts without a native icon
   * catalog (Android `PopupMenu`, Electron `Menu`). Absent until the web side
   * has rasterized it; absence degrades to a text-only row.
   */
  iconPng?: string;
  enabled: boolean;
  /** Checkmark state. */
  checked?: boolean;
  children?: NativeMenuItem[];
}

export interface TasferBridge {
  /**
   * Whether developer tools (the in-app DevToolbar) should be shown, read from
   * the native shell's OS-level setting at launch. iOS sources this from a
   * Settings-bundle toggle (`UserDefaults`); it is injected synchronously into
   * the bridge literal at `.atDocumentStart`. Absent on shells that don't
   * provide an OS-level control. See `@/lib/devTools`.
   */
  devToolsEnabled?: boolean;

  clipboard: {
    copy(text: string): Promise<void>;
    cut(text: string): Promise<void>;
    paste(): Promise<string>;
  };

  haptic: {
    trigger(style: "light" | "medium" | "heavy"): Promise<void>;
  };

  editor: {
    setColorScheme(scheme: "light" | "dark"): Promise<void>;
    /**
     * Present a platform-native context menu and resolve with the chosen item's
     * id, or null if the menu was dismissed without a selection.
     *
     * `anchor` is the trigger rectangle in viewport-relative CSS pixels; the
     * native side converts to its own coordinate space (1:1 with WKWebView
     * points on iOS, density-scaled on Android).
     *
     * Optional — shells that don't implement it fall back to the web popover.
     */
    showContextMenu?(req: {
      model: NativeMenuItem[];
      anchor: { x: number; y: number; width: number; height: number };
    }): Promise<string | null>;
  };

  navigation: {
    openUrl(url: string): Promise<void>;
    openPhotoLibrary(): Promise<void>;
    openCamera(): Promise<void>;
  };

  files: {
    shareFile(
      base64Data: string,
      fileName: string,
      mimeType: string,
    ): Promise<boolean>;
    /**
     * Render HTML to a PDF using the native WebView. Returns base64-encoded
     * PDF bytes, or null if the platform doesn't support it.
     * Optional — older shells may not implement it.
     */
    htmlToPdf?(html: string): Promise<string | null>;
  };

  storage: {
    write(path: string, base64Data: string): Promise<boolean>;
    read(path: string): Promise<string | null>;
    delete(path: string): Promise<boolean>;
    list(path: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
    getInfo(): Promise<{ free: number; total: number }>;
  };

  /**
   * App-level host settings that outlive a single editor view.
   * Optional — shells built before this existed omit it.
   */
  app?: {
    /**
     * Adopt `tag` (a BCP-47 language tag) as the shell's UI language, so text
     * the WebView never draws — permission dialogs, toasts, the iOS Settings
     * bundle — follows the in-app language picker instead of the device
     * language. See `setNativeLocale`.
     */
    setLocale(tag: string): Promise<void>;
    /**
     * The shell's explicitly-chosen locale, "" when it follows the system.
     * iOS injects it as a launch-time snapshot; Android exposes a live
     * `__NativeBridge.getLocale()` instead. See `getNativeExplicitLocale`.
     */
    initialLocale?: string;
  };

  /**
   * App-lifecycle coordination for background sync. The native shell calls
   * `window.__tasferLifecycle.onPause/onResume` (see SyncLifecycleController)
   * around app background/foreground; the web side calls `endFlush()` back to
   * release the native background task once teardown finishes. Optional —
   * shells without a background-task window omit it. Fire-and-forget.
   */
  lifecycle?: {
    endFlush(): void;
  };
}

export interface TasferEditorCallbacks {
  undo?: () => void;
  redo?: () => void;
  setBlockType?: (type: string) => void;
  focus?: () => void;
  onFormatButtonClick?: () => boolean;
  toggleStrong?: () => void;
  toggleEmphasis?: () => void;
  toggleCode?: () => void;
  toggleStrike?: () => void;
}

// =============================================================================
// Global augmentation
// =============================================================================

declare global {
  interface Window {
    TasferBridge?: TasferBridge;
    TasferEditorCallbacks?: TasferEditorCallbacks;
    /**
     * Android's raw JavascriptInterface object. Unlike the TasferBridge shim
     * (injected at page load), it exists from document start, which locale
     * detection depends on.
     */
    __NativeBridge?: { getLocale?: () => string };
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** Returns the TasferBridge if running inside a native shell, or null on web. */
export function getBridge(): TasferBridge | null {
  return typeof window !== "undefined" ? (window.TasferBridge ?? null) : null;
}

/** True when running inside a native iOS/Android shell. */
export function isNative(): boolean {
  return !!getBridge();
}

/**
 * Push the color scheme to the native host so OS-drawn chrome (context menus,
 * tray, application menu) matches the in-app theme.
 *
 * `scheme` is the resolved light/dark used for immediate rendering. `source` is
 * the user's theme setting — pass "system" so hosts that can defer to the OS
 * keep following it (and OS theme changes still propagate); it defaults to the
 * resolved scheme when the caller has no distinct setting.
 *
 * iOS/Android receive the resolved scheme through the unified TasferBridge.
 * Electron desktop has no TasferBridge — it uses the generic `window.tasfer`
 * IPC bridge (see `nativeContextMenu`) — and would otherwise leave `nativeTheme`
 * following the desktop environment's theme (e.g. dark GTK under i3), so we
 * route the `source` over that bridge and let the main process drive
 * `nativeTheme.themeSource`. Plain web is a no-op. Fire-and-forget: a missing or
 * failing host must never break theming.
 */
export function setNativeColorScheme(
  scheme: "light" | "dark",
  source: "light" | "dark" | "system" = scheme,
): void {
  try {
    void getBridge()?.editor.setColorScheme(scheme);
  } catch (e) {
    console.debug("setColorScheme (native bridge) failed:", e);
  }
  try {
    const desktop = (
      window as unknown as {
        tasfer?: {
          invoke(channel: string, ...args: unknown[]): Promise<unknown>;
        };
      }
    ).tasfer;
    void desktop?.invoke("editor:setColorScheme", source);
  } catch (e) {
    console.debug("setColorScheme (desktop bridge) failed:", e);
  }
}

/** Session pin for an in-app language choice; dies with the WebView session. */
const LOCALE_PIN_KEY = "tasfer.locale.pin";

/** Plain language tag, also safe to interpolate anywhere. */
const LOCALE_TAG_RE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

/**
 * The locale the native shell is explicitly set to, or null when there is no
 * shell or it follows the system language.
 *
 * Consulted by i18next detection ahead of the web cookie/localStorage caches:
 * the OS per-app language setting and the in-app picker both land in the
 * native store, so it always holds the latest explicit choice — a cached web
 * value must not outrank it (it did: an Android 13 user's Settings choice was
 * reverted by the web cache on the next start).
 *
 * The session pin covers the one stale window: iOS's `initialLocale` is a
 * launch-time snapshot, so right after the picker runs, the pin written by
 * `setNativeLocale` is fresher for same-session reloads.
 */
export function getNativeExplicitLocale(): string | null {
  if (typeof window === "undefined") return null;
  let tag: string | null = null;
  try {
    tag = window.sessionStorage.getItem(LOCALE_PIN_KEY);
  } catch {
    // Storage-less contexts fall through to the shell itself.
  }
  if (!tag) {
    try {
      tag =
        window.__NativeBridge?.getLocale?.() ??
        getBridge()?.app?.initialLocale ??
        null;
    } catch (e) {
      console.debug("getNativeExplicitLocale failed:", e);
      return null;
    }
  }
  if (!tag) return null;
  // Android returns a comma-separated LocaleList; the first tag decides. Only
  // its language subtag is returned: i18next prefers an exact supportedLngs
  // match from ANY detector over a regional variant from a higher-priority
  // one, so a native "ar-EG" (iOS Settings and Android's suggested locales
  // write regioned tags) would lose to a stale cached "en" — the exact revert
  // this function exists to prevent.
  const first = tag.split(",")[0];
  if (!LOCALE_TAG_RE.test(first)) return null;
  return first.split("-")[0].toLowerCase();
}

/**
 * Push an explicit in-app language choice to the native host so OS-drawn text
 * (permission prompts, toasts, native menus) follows the picker.
 *
 * Called only when the user picks a language — never at startup. Startup runs
 * the other direction: i18next reads the shell's stored locale through
 * `getNativeExplicitLocale`, keeping the native store the single source of
 * truth on mobile.
 *
 * `tag` is a BCP-47 language tag. Android applies it via
 * `AppCompatDelegate.setApplicationLocales`, iOS writes the `AppleLanguages`
 * default (lands next launch — the session pin bridges the gap), Electron
 * rebuilds its menu and tray. Plain web is a no-op (the `locale` cookie
 * already governs it). Fire-and-forget: a missing or failing host must never
 * break the language switch itself.
 */
export function setNativeLocale(tag: string): void {
  try {
    const app = getBridge()?.app;
    if (app) {
      window.sessionStorage.setItem(LOCALE_PIN_KEY, tag);
      void app.setLocale(tag);
    }
  } catch (e) {
    console.debug("setLocale (native bridge) failed:", e);
  }
  try {
    const desktop = (
      window as unknown as {
        tasfer?: {
          invoke(channel: string, ...args: unknown[]): Promise<unknown>;
        };
      }
    ).tasfer;
    void desktop?.invoke("app:setLocale", tag);
  } catch (e) {
    console.debug("setLocale (desktop bridge) failed:", e);
  }
}

/**
 * Fire device haptic feedback from host UI (sidebar, calendar, context menus).
 * Uses the native shell's haptic when present, else the web Vibration API.
 */
export function triggerHaptic(
  style: "light" | "medium" | "heavy" = "medium",
): void {
  try {
    const bridge = getBridge();
    if (bridge) {
      void bridge.haptic.trigger(style);
      return;
    }
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      const duration = style === "light" ? 10 : style === "medium" ? 20 : 50;
      navigator.vibrate(duration);
    }
  } catch (e) {
    console.debug("Haptic feedback not supported:", e);
  }
}
