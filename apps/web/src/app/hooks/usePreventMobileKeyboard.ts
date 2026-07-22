import { useEffect } from "react";

/**
 * Custom hook to prevent the mobile keyboard from appearing when a drawer/modal opens
 * This is particularly useful for mobile drawers where we don't want the keyboard
 * to interfere with the drawer's UI
 * 
 * @param isMobile - Whether the current device is mobile
 */
export function usePreventMobileKeyboard(isMobile: boolean) {
  useEffect(() => {
    if (isMobile) {
      // Find all hidden inputs (editor's hidden input) and temporarily disable them
      const hiddenInputs = Array.from(document.querySelectorAll('input[type="text"]')).filter(
        (input) => {
          const style = window.getComputedStyle(input);
          return style.opacity === '0' || input.hasAttribute('aria-hidden');
        }
      ) as HTMLInputElement[];

      // Store original properties
      const originalProps = hiddenInputs.map(input => ({
        input,
        inputMode: input.inputMode,
        readOnly: input.readOnly,
      }));

      // Disable keyboard on hidden inputs
      hiddenInputs.forEach(input => {
        input.inputMode = 'none';
        input.readOnly = true;
        input.blur();
      });

      // Blur any active element
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      // Additional blur attempts to handle race conditions
      const blurInterval = setInterval(() => {
        if (document.activeElement instanceof HTMLElement && 
            hiddenInputs.includes(document.activeElement as HTMLInputElement)) {
          document.activeElement.blur();
        }
      }, 50);

      // Cleanup function
      return () => {
        clearInterval(blurInterval);
        // Restore original properties
        originalProps.forEach(({ input, inputMode, readOnly }) => {
          input.inputMode = inputMode;
          input.readOnly = readOnly;
        });
      };
    }
  }, [isMobile]);
}

