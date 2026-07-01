import type { Metadata } from "next";
import RootRedirect from "./RootRedirect";

// The apex path "/" is not a real landing page — it redirects to /home (the
// canonical landing route). Point its canonical at /home so if a crawler indexes
// "/" before following the redirect, ranking signals still consolidate on /home.
export const metadata: Metadata = {
  alternates: { canonical: "/home" },
};

export default function RootPage() {
  return <RootRedirect />;
}
