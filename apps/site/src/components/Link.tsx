"use client";

import NextLink from "next/link";
import type { ComponentProps } from "react";

type NextLinkProps = ComponentProps<typeof NextLink>;

/**
 * Drop-in replacement for react-router-dom's `<Link>`.
 *
 * The marketing/docs components were written against react-router and use
 * `<Link to="/docs/...">`. This shim maps `to` → next/link's `href` so every
 * call site stays unchanged — only the import path swaps to `@/components/Link`.
 */
export function Link({
  to,
  ...rest
}: Omit<NextLinkProps, "href"> & { to: NextLinkProps["href"] }) {
  return <NextLink href={to} {...rest} />;
}

export default Link;
