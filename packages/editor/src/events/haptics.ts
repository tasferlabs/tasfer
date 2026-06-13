import type { HostBridge } from "../state-types";

/**
 * Trigger haptic feedback through the host's native bridge (iOS/Android),
 * falling back to the standard Vibration API where available. The bridge comes
 * from the editor's per-instance state (`state.hostBridge`); pass `null` on web.
 */
export function triggerHapticFeedback(
  bridge: HostBridge | null,
  style: "light" | "medium" | "heavy" = "heavy",
): void {
  try {
    // Native bridge (iOS / Android)
    if (bridge?.haptic) {
      bridge.haptic(style);
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
