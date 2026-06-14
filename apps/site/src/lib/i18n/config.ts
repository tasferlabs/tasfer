import i18next, { type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./en.json";
import ar from "./ar.json";

export const SUPPORTED_LNGS = ["en", "ar"] as const;
export type Lng = (typeof SUPPORTED_LNGS)[number];

/**
 * Shared i18next instance for the site.
 *
 * Initialized synchronously with bundled resources (no HTTP backend) so `t()`
 * returns real strings during static prerender and on first client render. The
 * default language is "en" on both server and client to avoid hydration
 * mismatches; the actual user language is detected client-side in I18nProvider
 * (cookie `locale` / navigator) and applied via `changeLanguage`.
 */
export function getI18n(): I18nInstance {
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      resources: {
        en: { translation: en },
        ar: { translation: ar },
      },
      lng: "en",
      fallbackLng: "en",
      supportedLngs: SUPPORTED_LNGS as unknown as string[],
      defaultNS: "translation",
      fallbackNS: "translation",
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  }
  return i18next;
}

/** Detect the preferred language from cookie / navigator (client only). */
export function detectLng(): Lng {
  if (typeof document !== "undefined") {
    const match = document.cookie.match(/(?:^|;\s*)locale=([^;]+)/);
    const cookieLng = match?.[1];
    if (cookieLng && (SUPPORTED_LNGS as readonly string[]).includes(cookieLng)) {
      return cookieLng as Lng;
    }
  }
  if (typeof navigator !== "undefined") {
    const nav = navigator.language?.toLowerCase() ?? "";
    if (nav.startsWith("ar")) return "ar";
  }
  return "en";
}

export default getI18n;
