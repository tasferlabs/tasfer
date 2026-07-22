"use client";

import { I18nProvider } from "./I18nProvider";
import { ThemeProvider } from "./ThemeProvider";
import type { Lng } from "@/lib/i18n/locales";

/** Client provider stack shared by every route (i18n + theme). */
export function Providers({
  children,
  lng,
}: {
  children: React.ReactNode;
  lng: Lng;
}) {
  return (
    <I18nProvider lng={lng}>
      <ThemeProvider>{children}</ThemeProvider>
    </I18nProvider>
  );
}

export default Providers;
