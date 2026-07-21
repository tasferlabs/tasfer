import React, { createContext, useContext, useEffect, useState } from "react";
import { invariant } from "@shared/invariant";
import { setNativeColorScheme } from "@/platform/bridge";

export type Theme = "light" | "dark" | "system";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  effectiveTheme: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    // Get theme from localStorage or default to system
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("theme") as Theme;
      return stored || "system";
    }
    return "system";
  });

  // The OS light/dark setting. Normally `prefers-color-scheme`, but the Android
  // shell reports it explicitly — see the listener below.
  const [systemScheme, setSystemScheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  const [effectiveTheme, setEffectiveTheme] = useState<"light" | "dark">(() => {
    if (typeof window !== "undefined") {
      if (theme === "system") {
        return systemScheme;
      }
      return theme === "dark" ? "dark" : "light";
    }
    return "light";
  });

  // Track the OS setting regardless of the current theme, so switching back to
  // "system" resolves against a value that is still current.
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onMediaChange = () =>
      setSystemScheme(mediaQuery.matches ? "dark" : "light");

    // The Android WebView answers `prefers-color-scheme` from the activity
    // theme's `isLightTheme`, which it resolved when the WebView was created.
    // The activity declares `uiMode` in its `configChanges`, so an OS theme
    // switch never recreates it and the media query keeps reporting the old
    // value; MainActivity posts the change instead. Other platforms never send
    // this message and stay on the media query alone.
    const onNativeScheme = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; scheme?: unknown } | null;
      if (
        event.source !== window ||
        !data ||
        data.type !== "system-color-scheme-changed"
      ) {
        return;
      }
      if (data.scheme === "dark" || data.scheme === "light") {
        setSystemScheme(data.scheme);
      }
    };

    mediaQuery.addEventListener("change", onMediaChange);
    window.addEventListener("message", onNativeScheme);
    return () => {
      mediaQuery.removeEventListener("change", onMediaChange);
      window.removeEventListener("message", onNativeScheme);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    // Sync color scheme to native platforms (iOS/Android)
    // This ensures context menus, selection UI and other native chrome match
    // the app theme (on iOS the soft keyboard follows too; Android leaves IME
    // theming to the system).
    const syncNativeColorScheme = (scheme: "light" | "dark") => {
      // Set CSS color-scheme for browser/webview hints
      root.style.colorScheme = scheme;

      // Update color-scheme meta tag (required for keyboard theme on some browsers/webviews)
      const metaColorScheme = document.querySelector('meta[name="color-scheme"]');
      if (metaColorScheme) {
        metaColorScheme.setAttribute("content", scheme);
      }

      // Sync to native platform. Covers both the iOS/Android TasferBridge and
      // the Electron desktop bridge (window.tasfer), so OS-drawn chrome like the
      // native context menu follows the in-app theme rather than the desktop
      // environment's theme. `theme` (the setting, incl. "system") is passed as
      // the source so hosts keep deferring to the OS in system mode instead of
      // pinning themselves to the scheme that happens to be resolved now.
      setNativeColorScheme(scheme, theme);
    };

    // Update effective theme based on theme setting
    const updateEffectiveTheme = () => {
      const newEffectiveTheme: "light" | "dark" =
        theme === "system" ? systemScheme : theme === "dark" ? "dark" : "light";

      setEffectiveTheme(newEffectiveTheme);

      // Update DOM class
      if (newEffectiveTheme === "dark") {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }

      // Sync to native platforms
      syncNativeColorScheme(newEffectiveTheme);
    };

    updateEffectiveTheme();
  }, [theme, systemScheme]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem("theme", newTheme);
  };

  const value = { theme, setTheme, effectiveTheme };

  return React.createElement(
    ThemeContext.Provider,
    { value },
    children
  );
}

export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  invariant(context, "useTheme must be used within a ThemeProvider");
  return context;
};

