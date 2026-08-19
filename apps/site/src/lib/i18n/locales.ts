import en from "./en.json";

export const SUPPORTED_LNGS = ["en"] as const;
export type Lng = (typeof SUPPORTED_LNGS)[number];

/** Locale for routes rendered outside `[lang]` — the global 404. */
export const DEFAULT_LNG: Lng = "en";

export function isLng(value: string): value is Lng {
  return (SUPPORTED_LNGS as readonly string[]).includes(value);
}

export function getDictionary(_lng: Lng) {
  return en;
}

export const resources = {
  en: { translation: en },
};
