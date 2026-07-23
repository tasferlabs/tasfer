import React, { createContext, useContext, useEffect, useState } from "react";
import { invariant } from "@shared/invariant";
import { faviconUrl } from "@/lib/favicon";
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

  const [effectiveTheme, setEffectiveTheme] = useState<"light" | "dark">(() => {
    if (typeof window !== "undefined") {
      if (theme === "system") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      return theme === "dark" ? "dark" : "light";
    }
    return "light";
  });

  useEffect(() => {
    const root = document.documentElement;

    // Sync color scheme to native platforms (iOS/Android)
    // This ensures keyboard, context menus, and other native UI match the app theme
    const syncNativeColorScheme = (scheme: "light" | "dark") => {
      // Set CSS color-scheme for browser/webview hints
      root.style.colorScheme = scheme;

      // Update color-scheme meta tag (required for keyboard theme on some browsers/webviews)
      const metaColorScheme = document.querySelector('meta[name="color-scheme"]');
      if (metaColorScheme) {
        metaColorScheme.setAttribute("content", scheme);
      }

      const metaThemeColor = document.querySelector('meta[name="theme-color"]');
      if (metaThemeColor) {
        metaThemeColor.setAttribute("content", scheme === "dark" ? "#09090b" : "#ffffff");
      }

      // Production follows the theme; environment-specific favicons stay on
      // their light palette (index.html sets the pre-paint production value).
      const favicon = document.getElementById("favicon");
      if (favicon) {
        favicon.setAttribute("href", faviconUrl(scheme));
      }

      // Sync to native platform. Covers both the iOS/Android TasferBridge and
      // the Electron desktop bridge (window.tasfer), so OS-drawn chrome like the
      // native context menu follows the in-app theme rather than the desktop
      // environment's theme. `theme` (the setting, incl. "system") is passed as
      // the source so desktop keeps deferring to the OS in system mode.
      setNativeColorScheme(scheme, theme);
    };

    // Update effective theme based on theme setting
    const updateEffectiveTheme = () => {
      let newEffectiveTheme: "light" | "dark";

      if (theme === "system") {
        const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        newEffectiveTheme = isDark ? "dark" : "light";
      } else {
        newEffectiveTheme = theme === "dark" ? "dark" : "light";
      }

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

    // Listen for system theme changes
    if (theme === "system") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => updateEffectiveTheme();
      mediaQuery.addEventListener("change", handler);
      return () => mediaQuery.removeEventListener("change", handler);
    }
  }, [theme]);

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
