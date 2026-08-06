/**
 * Which key conventions the host OS follows. macOS/iOS split the two roles that
 * Windows and Linux both put on Ctrl: ⌘ is the *command* modifier (undo, bold,
 * line edges) and ⌥ is the *word* modifier. Conflating them is what makes a mac
 * build feel like a port, so the key handler asks this instead of testing
 * `ctrlKey || metaKey`.
 *
 * Read from `navigator` on every call rather than cached at module load: no
 * shared mutable state, and a test can stub the global before exercising a
 * keymap branch.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  // `navigator.platform` is deprecated and frozen in some engines; prefer the
  // UA-Client-Hints value where it exists and fall back for Safari/WebKit.
  const hinted = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;
  if (hinted) return /mac|ios/i.test(hinted);
  const ua = navigator.userAgent || "";
  // iPadOS 13+ reports a Mac UA — both are Apple platforms here, so one test
  // covers them.
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || ua);
}
