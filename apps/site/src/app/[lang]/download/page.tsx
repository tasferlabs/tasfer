import type { Metadata } from "next";
import DownloadPage from "@/views/DownloadPage/DownloadPage";
import { getDictionary, isLng, SUPPORTED_LNGS } from "@/lib/i18n/locales";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLng(lang)) return {};
  const dictionary = getDictionary(lang);

  return {
    title: dictionary["download.metadata.title"],
    description: dictionary["download.metadata.description"],
    alternates: {
      canonical: `/${lang}/download`,
      languages: Object.fromEntries(
        SUPPORTED_LNGS.map((locale) => [locale, `/${locale}/download`]),
      ),
    },
  };
}

export default function Page() {
  return <DownloadPage />;
}
