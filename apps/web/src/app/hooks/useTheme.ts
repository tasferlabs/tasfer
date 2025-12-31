import React, { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

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

    // Update effective theme based on theme setting
    const updateEffectiveTheme = () => {
      if (theme === "system") {
        const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        setEffectiveTheme(isDark ? "dark" : "light");
        if (isDark) {
          root.classList.add("dark");
        } else {
          root.classList.remove("dark");
        }
      } else {
        setEffectiveTheme(theme === "dark" ? "dark" : "light");
        if (theme === "dark") {
          root.classList.add("dark");
        } else {
          root.classList.remove("dark");
        }
      }
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
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};

