import type { Metadata } from "next";
import HomePage from "@/views/HomePage/HomePage";
import { getDictionary, isLng } from "@/lib/i18n/locales";
import { getOgImage } from "@/lib/og";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLng(lang)) return {};
  const dictionary = getDictionary(lang);
  const title = dictionary["metadata.title"];
  const description = dictionary["metadata.description"];
  return {
    alternates: {
      canonical: `/${lang}/home`,
      languages: { en: "/en/home" },
    },
    openGraph: {
      type: "website",
      locale: lang,
      siteName: "Tasfer",
      title,
      description,
      url: `/${lang}/home`,
      images: [
        {
          url: getOgImage("home", lang),
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
  };
}

export default function Page() {
  return <HomePage />;
}
