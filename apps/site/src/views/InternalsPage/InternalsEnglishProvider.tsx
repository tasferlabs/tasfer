"use client";

import { useState, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "@/lib/i18n/config";

/** Keeps the English-only Internals section independent of the route locale. */
export function InternalsEnglishProvider({ children }: { children: ReactNode }) {
  const [i18n] = useState(() => createI18n("en"));
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
