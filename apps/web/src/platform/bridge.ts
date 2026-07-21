/**
 * Native Bridge — TasferBridge
 *
 * Both iOS and Android inject `window.TasferBridge` with the same shape.
 * All methods return Promises so consumers never need platform branching.
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
    /**
     * Push the resolved light/dark scheme, plus the user's theme *setting*, to
     * the shell so its own chrome (context menus, selection handles, system
     * bars) follows the in-app theme.
     *
     * `source` is "system" whenever the app is following the OS. Shells pin
     * their night mode to `scheme` only for an explicit light/dark setting;
     * pinning it in system mode would freeze the WebView's
     * `prefers-color-scheme` at the current value and the app would stop
     * following the OS entirely.
     */
    setColorScheme(
      scheme: "light" | "dark",
      source: "light" | "dark" | "system",
    ): Promise<void>;
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
 * iOS/Android receive both through the unified TasferBridge.
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
    void getBridge()?.editor.setColorScheme(scheme, source);
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
