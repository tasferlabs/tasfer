import { useState, useEffect } from "react";

/**
 * Hook to track whether the mobile keyboard is currently open.
 * Listens to keyboard-show/keyboard-hide messages sent from native iOS/Android wrappers.
 */
export function useKeyboardOpen(): boolean {
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "keyboard-show") {
        setIsKeyboardOpen(true);
      } else if (event.data?.type === "keyboard-hide") {
        setIsKeyboardOpen(false);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return isKeyboardOpen;
}
