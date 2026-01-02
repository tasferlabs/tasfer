import React, { createContext, useContext, useState, useCallback } from "react";
import { setCurrentFontFamily, type FontFamily } from "../../editor/fonts";

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
  const [fontStyle, setFontStyleState] = useState<FontStyle>("default");
  const [isSaving, setIsSaving] = useState(false);
  const [showWordCount, setShowWordCount] = useState(false);
  const [wordCount, setWordCount] = useState(0);

  const setFontStyle = useCallback((style: FontStyle) => {
    setFontStyleState(style);
    setCurrentFontFamily(fontStyleToFamily(style));
  }, []);

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

