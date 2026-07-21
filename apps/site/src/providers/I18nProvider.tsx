"use client";

import { useEffect } from "react";
import { I18nextProvider } from "react-i18next";
import { getI18n, detectLng } from "@/lib/i18n/config";
import { loadArabicFonts } from "@/lib/fonts";

const i18n = getI18n();

/**
 * Wraps the app in react-i18next's provider.
 *
 * Language detection runs client-side (after hydration) to keep the server and
 * first-client render identical ("en"). When the detected language differs, it
 * switches via changeLanguage; the document `dir` is kept in sync (ar → rtl),
 * mirroring apps/web/src/main.tsx. The pre-hydration script in app/layout.tsx
 * has already applied the same lang/dir, so this is a re-affirm, not a flip.
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const applyLng = () => {
      document.documentElement.dir = i18n.dir();
      document.documentElement.lang = i18n.language;
      if (i18n.language.split("-")[0] === "ar") void loadArabicFonts();
    };

    const detected = detectLng();
    if (detected !== i18n.language) {
      void i18n.changeLanguage(detected);
    } else {
      applyLng();
    }

    i18n.on("languageChanged", applyLng);
    return () => {
      i18n.off("languageChanged", applyLng);
    };
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

export default I18nProvider;
