"use client";

import { useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { createI18n, type Lng } from "@/lib/i18n/config";

/**
 * Wraps the app in react-i18next's provider.
 *
 * The route locale initializes an instance synchronously, so static HTML and
 * hydration render the same language. Instances are scoped to the provider;
 * concurrent locale renders never mutate shared module state.
 */
export function I18nProvider({
  children,
  lng,
}: {
  children: React.ReactNode;
  lng: Lng;
}) {
  const [i18n] = useState(() => createI18n(lng));

  useEffect(() => {
    document.cookie = `locale=${lng}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, [lng]);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

export default I18nProvider;
