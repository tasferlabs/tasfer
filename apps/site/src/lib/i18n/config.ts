import { createInstance, type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import { resources, SUPPORTED_LNGS, type Lng } from "./locales";

export type { Lng } from "./locales";

/** Create an isolated instance so multiple locale variants can render safely. */
export function createI18n(lng: Lng): I18nInstance {
  const i18n = createInstance();
  void i18n.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LNGS],
    defaultNS: "translation",
    fallbackNS: "translation",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    initAsync: false,
  });
  return i18n;
}
