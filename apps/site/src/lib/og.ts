export type OgPage = "home" | "docs" | "download" | "privacy";

export function getOgImage(page: OgPage, lang: string) {
  const suffix = lang === "ar" ? ".ar" : "";
  return page === "home" ? `/og${suffix}.png` : `/og/${page}${suffix}.png`;
}
