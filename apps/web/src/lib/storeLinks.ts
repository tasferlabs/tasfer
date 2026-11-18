import { getClientPlatform } from "@/platform";

/** The app's App Store listing. */
export const APP_STORE_URL = "https://apps.apple.com/app/tasfer/id6794223843";

/**
 * The app's Google Play listing. Built from the application id (app.tasfer),
 * so it resolves once the listing exists.
 */
export const GOOGLE_PLAY_URL =
  "https://play.google.com/store/apps/details?id=app.tasfer";

/** Which store a phone app was installed from. */
export type StoreName = "appStore" | "googlePlay";

/**
 * The store listing for the app that is running, or null where it did not come
 * from a store (web, desktop).
 */
export function storeListing(): { store: StoreName; url: string } | null {
  const platform = getClientPlatform();
  if (platform === "ios") return { store: "appStore", url: APP_STORE_URL };
  if (platform === "android")
    return { store: "googlePlay", url: GOOGLE_PLAY_URL };
  return null;
}
