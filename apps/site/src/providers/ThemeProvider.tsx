"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

/**
 * Theme context — ported from apps/web/src/app/hooks/useTheme.ts.
 *
 * Self-contained client state: persists to localStorage, follows the OS theme
 * when set to "system", and toggles the `.dark` class on <html>. (The native
 * TasferBridge color-scheme sync from the original is dropped — irrelevant here.)
 */

export type Theme = "light" | "dark" | "system";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  effectiveTheme: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Initialize to deterministic defaults so the first client render matches the
  // server (SSR has no access to localStorage / matchMedia — reading them in the
  // initializer diverges any theme-dependent output and trips hydration). The
  // stored theme is read after mount below; the pre-hydration script in
  // layout.tsx has already applied the correct `.dark` class, so there's no
  // visual flash while React catches up.
  const [theme, setThemeState] = useState<Theme>("system");
  const [effectiveTheme, setEffectiveTheme] = useState<"light" | "dark">("light");

  // Pick up the persisted choice once, after hydration. When it's "system" (or
  // unset) the theme stays "system" and the effect below resolves it from the OS
  // preference; otherwise this flips `theme` and re-runs that effect.
  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    if (stored === "light" || stored === "dark") {
      setThemeState(stored);
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    const updateEffectiveTheme = () => {
      let newEffectiveTheme: "light" | "dark";

      if (theme === "system") {
        const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        newEffectiveTheme = isDark ? "dark" : "light";
      } else {
        newEffectiveTheme = theme === "dark" ? "dark" : "light";
      }

      setEffectiveTheme(newEffectiveTheme);
      root.style.colorScheme = newEffectiveTheme;

      if (newEffectiveTheme === "dark") {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
    };

    updateEffectiveTheme();

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

  return React.createElement(ThemeContext.Provider, { value }, children);
}

export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};
