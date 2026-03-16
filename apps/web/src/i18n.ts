import i18next from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import Backend, { type HttpBackendOptions } from "i18next-http-backend";
import { initReactI18next } from "react-i18next";

i18next
  .use(LanguageDetector)
  .use(Backend)
  .use(initReactI18next)
  .init<HttpBackendOptions>({
    detection: {
      lookupCookie: "locale",
    },
    fallbackLng: "en",
    supportedLngs: ["en", "ar"],
    backend: {
      loadPath: "/app/locales/{{lng}}/{{ns}}.json",
    },
    fallbackNS: "translation",
    defaultNS: "translation",
  });
