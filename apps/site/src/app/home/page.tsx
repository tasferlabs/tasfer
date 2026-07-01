import type { Metadata } from "next";
import HomePage from "@/views/HomePage/HomePage";

// /home is the canonical landing route (the root path "/" redirects here). It
// inherits the site-wide title, OpenGraph and Twitter metadata from the root
// layout; this only pins its canonical URL so search engines index /home rather
// than the redirecting "/".
export const metadata: Metadata = {
  alternates: { canonical: "/home" },
};

export default function Page() {
  return <HomePage />;
}
