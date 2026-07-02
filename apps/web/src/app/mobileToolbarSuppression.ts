/**
 * Cross-surface coordination for the mobile formatting toolbar.
 *
 * The soft keyboard's formatting toolbar is a device-level singleton (one
 * keyboard per device): on iOS it is a native `inputAccessoryView` attached to
 * the whole WKWebView, and on Android/web it is the React
 * `MobileKeyboardToolbar` the body `PageEditor` renders whenever the keyboard
 * is open — in both cases keyed to the *keyboard*, not to which editor surface
 * raised it. A compact surface that wants a plain keyboard (the `TitleEditor`
 * — a single-line field has no block formatting) therefore needs a way to say
 * "while I hold focus, no formatting toolbar", or it inherits the body
 * editor's bar.
 *
 * This module is that channel. It is deliberately app-level mutable state —
 * like the font registry in `src/fonts.ts`, it models one host-level fact
 * shared by every editor instance, and the counter composes if several
 * suppressing surfaces overlap (dialog over dialog).
 */

/** True when running inside the native iOS (Capacitor/WKWebView) shell. */
function isIosNative(): boolean {
  return (
    (
      window as { Capacitor?: { getPlatform?: () => string } }
    ).Capacitor?.getPlatform?.() === "ios"
  );
}

/**
 * Tell the native iOS shell whether the canvas editor's input surface is
 * focused. iOS attaches the `inputAccessoryView` to the whole WKWebView, so
 * without this gate every DOM field (find bar, dialogs, settings) would also
 * show the formatting toolbar. The native shell shows the accessory only while
 * this is true. No-op off iOS / when the handler isn't registered.
 */
export function postKeyboardAccessoryFocus(focused: boolean): void {
  (
    window as {
      webkit?: {
        messageHandlers?: {
          KeyboardToolbarFocus?: { postMessage(m: unknown): void };
        };
      };
    }
  ).webkit?.messageHandlers?.KeyboardToolbarFocus?.postMessage(focused);
}

let suppressors = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of [...listeners]) cb();
}

/** Whether any surface is currently suppressing the formatting toolbar. */
export function isFormattingToolbarSuppressed(): boolean {
  return suppressors > 0;
}

/**
 * Subscribe to suppression changes (for the `PageEditor` to hide/show its
 * React toolbar). Returns unsubscribe.
 */
export function onFormattingToolbarSuppressionChange(
  cb: () => void,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Suppress the formatting toolbar while the calling surface holds focus.
 * Returns a release function; call it on blur/unmount. Idempotent — releasing
 * twice is a no-op.
 *
 * On iOS this also disables the native accessory immediately: the body
 * editor's blur normally does that, but the suppressing surface may gain focus
 * when no body editor is mounted (or when the enable flag went stale), so the
 * suppressor posts the disable itself. It never posts re-enable — only a body
 * editor gaining focus does that, which is exactly the "wants the toolbar"
 * signal.
 */
export function suppressFormattingToolbar(): () => void {
  suppressors++;
  if (suppressors === 1) notify();
  if (isIosNative()) postKeyboardAccessoryFocus(false);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    suppressors--;
    if (suppressors === 0) notify();
  };
}
