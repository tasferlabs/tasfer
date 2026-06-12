"use client";

import { useEffect } from "react";

/**
 * Root redirect → /home (the canonical landing route, matching the editor app's
 * inbound links). A client redirect is used instead of next/navigation redirect
 * because this site is statically exported (no request-time server).
 */
export default function RootPage() {
  useEffect(() => {
    window.location.replace("/home");
  }, []);
  return null;
}
