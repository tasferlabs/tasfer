import { isTouchOnlyDevice } from "./node-shared";

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

/**
 * Whether this environment implements HTML5 drag-and-drop — the platform
 * gesture the editor's text drag *is*. The editor contributes only the two ends
 * of that contract (what goes on the `DataTransfer`, what a drop commits); it
 * never re-implements the gesture, so where the platform has none the feature
 * is simply absent: no grab cursor, no draggable canvas, no drag listeners.
 *
 * Touch is the case that matters. Touch engines expose the `drag*` handlers but
 * never fire them for a finger — their real text-drag gesture belongs to the
 * native text views, not the web platform — so the handler probe alone would
 * promise an affordance that can never fire.
 */
export function supportsHtml5Drag(): boolean {
  if (typeof HTMLElement === "undefined") return false;
  if (isTouchOnlyDevice()) return false;
  return (
    "draggable" in HTMLElement.prototype &&
    "ondragstart" in HTMLElement.prototype &&
    "ondrop" in HTMLElement.prototype
  );
}
