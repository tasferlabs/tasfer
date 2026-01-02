import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { setCurrentFontFamily, type FontFamily } from "../../editor/fonts";
import useLocalStorage from "../hooks/useLocalStorage";

export type FontStyle = "default" | "serif";

interface PageSettingsContextType {
  fontStyle: FontStyle;
  setFontStyle: (style: FontStyle) => void;
  isSaving: boolean;
  setIsSaving: (isSaving: boolean) => void;
  showWordCount: boolean;
  setShowWordCount: (show: boolean) => void;
  wordCount: number;
  setWordCount: (count: number) => void;
}

const PageSettingsContext = createContext<PageSettingsContextType | undefined>(
  undefined
);

const fontStyleToFamily = (style: FontStyle): FontFamily => {
  return style === "serif" ? "merriweather" : "poppins";
};

export const PageSettingsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [fontStyle, setFontStyleState] = useLocalStorage<FontStyle>("pageSettings.fontStyle", "default");
  const [isSaving, setIsSaving] = useState(false);
  const [showWordCount, setShowWordCountState] = useLocalStorage<boolean>("pageSettings.showWordCount", false);
  const [wordCount, setWordCount] = useState(0);

  // Apply font family on mount and when fontStyle changes
  useEffect(() => {
    if (fontStyle) {
      setCurrentFontFamily(fontStyleToFamily(fontStyle));
    }
  }, [fontStyle]);

  const setFontStyle = useCallback((style: FontStyle) => {
    setFontStyleState(style);
    setCurrentFontFamily(fontStyleToFamily(style));
  }, [setFontStyleState]);

  const setShowWordCount = useCallback((show: boolean) => {
    setShowWordCountState(show);
  }, [setShowWordCountState]);

  return (
    <PageSettingsContext.Provider
      value={{ 
        fontStyle, 
        setFontStyle, 
        isSaving, 
        setIsSaving,
        showWordCount,
        setShowWordCount,
        wordCount,
        setWordCount,
      }}
    >
      {children}
    </PageSettingsContext.Provider>
  );
};

export const usePageSettings = (): PageSettingsContextType => {
  const context = useContext(PageSettingsContext);
  if (!context) {
    throw new Error("usePageSettings must be used within a PageSettingsProvider");
  }
  return context;
};

