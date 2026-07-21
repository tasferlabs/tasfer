"use client";

import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";

/** Selects an MDX article from the current i18n instance without global locale state. */
export function localizedMdx(
  English: ComponentType,
  Arabic: ComponentType,
): ComponentType {
  return function LocalizedMdx() {
    const { i18n } = useTranslation();
    const Article = i18n.resolvedLanguage?.split("-")[0] === "ar" ? Arabic : English;
    return <Article />;
  };
}
