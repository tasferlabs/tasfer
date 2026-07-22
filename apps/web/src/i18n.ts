import i18next from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import Backend, { type HttpBackendOptions } from "i18next-http-backend";
import { initReactI18next } from "react-i18next";
import { getNativeExplicitLocale } from "./platform/bridge";

// On mobile the native store holds the latest explicit language choice (OS
// per-app setting or in-app picker), so it must outrank the web-side caches —
// otherwise a stale cookie/localStorage value reverts an OS-level choice.
// Returns nothing on web/Electron, where the cookie governs.
const languageDetector = new LanguageDetector();
languageDetector.addDetector({
  name: "nativeShell",
  lookup: () => getNativeExplicitLocale() ?? undefined,
});

i18next
  .use(languageDetector)
  .use(Backend)
  .use(initReactI18next)
  .init<HttpBackendOptions>({
    detection: {
      lookupCookie: "locale",
      // Keep in step with the pre-paint mirror in index.html.
      order: ["querystring", "nativeShell", "cookie", "localStorage", "navigator"],
    },
    fallbackLng: "en",
    supportedLngs: ["en"],
    backend: {
      loadPath: import.meta.env.BASE_URL.startsWith("/")
        ? `${import.meta.env.BASE_URL.replace(/\/?$/, "/")}app/locales/{{lng}}/{{ns}}.json`
        : `${import.meta.env.BASE_URL}app/locales/{{lng}}/{{ns}}.json`,
    },
    fallbackNS: "translation",
    defaultNS: "translation",
  });
