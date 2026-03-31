import { useState, useEffect, useRef } from "react";

export interface KeyboardState {
  isKeyboardOpen: boolean;
  keyboardHeight: number;
}

/**
 * Hook to track whether the mobile soft keyboard is currently open.
 *
 * iOS (Capacitor + KeyboardResize.None): uses @capacitor/keyboard events.
 *   keyboardWillShow fires with the actual keyboardHeight before the animation,
 *   so the toolbar can animate in sync with the keyboard.
 *
 * Android: uses native postMessage from MainActivity (edge-to-edge means
 *   window.innerHeight - visualViewport.height is unreliable on Android).
 *
 * Web / desktop: uses the Visual Viewport API.
 */
export function useKeyboardOpen(): KeyboardState {
  const [state, setState] = useState<KeyboardState>({
    isKeyboardOpen: false,
    keyboardHeight: 0,
  });
  // Becomes true once a native source (iOS Capacitor events or Android postMessage)
  // has reported keyboard state. After that, the Visual Viewport fallback is ignored.
  const hasNativeKeyboardRef = useRef(false);

  // iOS Capacitor: use @capacitor/keyboard events (Android uses postMessage below)
  useEffect(() => {
    const isIOS = (window as any).Capacitor?.getPlatform?.() === "ios";
    if (!isIOS) return;

    let showListener: { remove: () => void } | null = null;
    let hideListener: { remove: () => void } | null = null;

    import("@capacitor/keyboard").then(({ Keyboard }) => {
      Keyboard.addListener("keyboardWillShow", (info) => {
        hasNativeKeyboardRef.current = true;
        setState((prev) =>
          prev.isKeyboardOpen && prev.keyboardHeight === info.keyboardHeight
            ? prev
            : { isKeyboardOpen: true, keyboardHeight: info.keyboardHeight }
        );
      }).then((l) => { showListener = l; });

      Keyboard.addListener("keyboardWillHide", () => {
        hasNativeKeyboardRef.current = true;
        setState((prev) =>
          !prev.isKeyboardOpen ? prev : { isKeyboardOpen: false, keyboardHeight: 0 }
        );
      }).then((l) => { hideListener = l; });
    });

    return () => {
      showListener?.remove();
      hideListener?.remove();
    };
  }, []);

  // Native Android keyboard height messages
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type !== "keyboard-height-changed") return;
      hasNativeKeyboardRef.current = true;
      const height = event.data.height as number;
      const isOpen = event.data.isOpen as boolean;
      setState((prev) => {
        if (prev.isKeyboardOpen === isOpen && prev.keyboardHeight === height)
          return prev;
        return { isKeyboardOpen: isOpen, keyboardHeight: height };
      });
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Visual Viewport API (web / desktop)
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const handleResize = () => {
      if (hasNativeKeyboardRef.current) return;
      const keyboardHeight = Math.max(0, window.innerHeight - viewport.height);
      const isKeyboardOpen = keyboardHeight > 50;
      setState((prev) => {
        if (
          prev.isKeyboardOpen === isKeyboardOpen &&
          prev.keyboardHeight === keyboardHeight
        )
          return prev;
        return { isKeyboardOpen, keyboardHeight };
      });
    };

    viewport.addEventListener("resize", handleResize);
    handleResize();

    return () => viewport.removeEventListener("resize", handleResize);
  }, []);

  return state;
}
