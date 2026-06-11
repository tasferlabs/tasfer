/**
 * Trigger haptic feedback through native bridges (iOS/Android), falling back
 * to the standard Vibration API where available.
 */
export function triggerHapticFeedback(
  style: "light" | "medium" | "heavy" = "heavy",
): void {
  try {
    // Native bridge (iOS / Android)
    if (window.CypherBridge) {
      window.CypherBridge.haptic.trigger(style);
      return;
    }

    // Fallback: Standard Vibration API (works on Android Chrome web, not in WebView usually)
    if ("vibrate" in navigator) {
      const duration = style === "light" ? 10 : style === "medium" ? 20 : 50;
      navigator.vibrate(duration);
    }
  } catch (e) {
    // Silently fail if haptics not supported
    console.debug("Haptic feedback not supported:", e);
  }
}
