"use client";

import NextLink from "next/link";
import { useParams } from "next/navigation";
import type { ComponentProps } from "react";
import { DEFAULT_LNG, isLng } from "@/lib/i18n/locales";

type NextLinkProps = ComponentProps<typeof NextLink>;

/**
 * Locale-aware wrapper around Next.js `<Link>`.
 *
 * View components use locale-neutral paths such as `/docs/...`; the active
 * App Router `[lang]` parameter is added here so links stay in the same locale.
 * Routes outside `[lang]` (the global 404) have no such parameter, so they fall
 * back to the default locale rather than emitting an unprefixed path that has
 * no exported page.
 */
export function Link({
  to,
  ...rest
}: Omit<NextLinkProps, "href"> & { to: NextLinkProps["href"] }) {
  const params = useParams<{ lang?: string }>();
  const lang = params.lang;
  const locale = lang && isLng(lang) ? lang : DEFAULT_LNG;
  const href =
    typeof to === "string" && to.startsWith("/") ? `/${locale}${to}` : to;
  return <NextLink href={href} {...rest} />;
}

export default Link;
