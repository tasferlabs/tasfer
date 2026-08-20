import type { Metadata } from "next";

import { DEFAULT_LNG, getDictionary } from "@/lib/i18n/locales";
import InternalsIndex from "@/views/InternalsPage/InternalsIndex";

// The archive renders in English regardless of locale (InternalsEnglishProvider),
// so its head follows the page rather than the URL's locale. `noindex` comes
// from the layout.
export const metadata: Metadata = {
  title: getDictionary(DEFAULT_LNG)["internals.archive.title"],
  description: getDictionary(DEFAULT_LNG)["internals.archive.lede"],
};

export default function Page() {
  return <InternalsIndex />;
}
