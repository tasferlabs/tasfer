import { isApplePlatform } from "@tasfer/editor";

/**
 * Display label for the platform's command modifier: "⌘" on Apple, "Ctrl"
 * everywhere else. Chords are drawn one keycap per key by `ShortcutKeys`, so
 * there is no single-string chord label.
 */
export function commandModifierLabel(): string {
  return isApplePlatform() ? "⌘" : "Ctrl";
}
