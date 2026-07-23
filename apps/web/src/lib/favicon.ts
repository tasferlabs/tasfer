import { publicAssetUrl } from "./publicAssetUrl";

type FaviconTheme = "light" | "dark";

const faviconEnvironment = import.meta.env.DEV
  ? "development"
  : import.meta.env.VERCEL_ENV === "preview"
    ? "preview"
    : null;

export function faviconUrl(theme: FaviconTheme): string {
  if (!faviconEnvironment) {
    return publicAssetUrl(`favicon-${theme}.svg`);
  }

  const styles = getComputedStyle(document.documentElement);
  const backgroundToken =
    faviconEnvironment === "development" ? "--primary" : "--destructive";
  const foregroundToken =
    faviconEnvironment === "development"
      ? "--primary-foreground"
      : "--background";
  const background = styles.getPropertyValue(backgroundToken).trim();
  const foreground = styles.getPropertyValue(foregroundToken).trim();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="102" fill="${background}"/><path d="M57 4Q79 34 83 66Q58 98 41 136Q30 98 17 64Q39 32 57 4Z" transform="translate(116.606 60.848) scale(2.78788)" fill="${foreground}"/></svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
