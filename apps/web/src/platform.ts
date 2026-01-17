/**
 * Platform Detection
 *
 * Detects whether the app is running in iOS WebView, Android WebView, or web browser.
 */

export type Platform = "ios" | "android" | "web";

/**
 * Detect the current platform.
 * iOS and Android apps should inject a global variable or user agent marker.
 */
export function detectPlatform(): Platform {
  // Check for native app markers (injected by WebView)
  if (typeof window !== "undefined") {
    // Check for iOS WebView marker
    if (
      (window as any).webkit?.messageHandlers?.nativeApp ||
      (window as any).__CYPHER_IOS__
    ) {
      return "ios";
    }

    // Check for Android WebView marker
    if ((window as any).AndroidBridge || (window as any).__CYPHER_ANDROID__) {
      return "android";
    }

    // Fallback: Check user agent for WebView indicators
    const ua = navigator.userAgent.toLowerCase();

    // iOS WebView detection
    if (/iphone|ipad|ipod/.test(ua) && !/safari/.test(ua)) {
      return "ios";
    }

    // Android WebView detection (wv = WebView)
    if (/android/.test(ua) && /wv/.test(ua)) {
      return "android";
    }
  }

  return "web";
}

/** Cached platform value */
let cachedPlatform: Platform | null = null;

/**
 * Get the current platform (cached after first detection)
 */
export function getPlatform(): Platform {
  if (cachedPlatform === null) {
    cachedPlatform = detectPlatform();
  }
  return cachedPlatform;
}
