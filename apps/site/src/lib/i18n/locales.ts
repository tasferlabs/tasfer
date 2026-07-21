import en from "./en.json";
import ar from "./ar.json";

export const SUPPORTED_LNGS = ["en", "ar"] as const;
export type Lng = (typeof SUPPORTED_LNGS)[number];

export function isLng(value: string): value is Lng {
  return (SUPPORTED_LNGS as readonly string[]).includes(value);
}

export function getDictionary(lng: Lng) {
  return lng === "ar" ? ar : en;
}

export const resources = {
  en: { translation: en },
  ar: { translation: ar },
};
