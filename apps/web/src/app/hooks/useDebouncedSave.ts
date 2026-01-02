import { useEffect, useRef, useCallback, useState } from "react";

/**
 * Hook to debounce save operations
 * @param callback - The save function to call
 * @param delay - Delay in milliseconds (default: 1000ms)
 * @returns Object with save function and saving state
 */
export function useDebouncedSave<T>(
  callback: (data: T) => void | Promise<void>,
  delay: number = 1000
) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDataRef = useRef<T | null>(null);
  const callbackRef = useRef(callback);
  const [isSaving, setIsSaving] = useState(false);

  // Keep callback ref up to date
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const save = useCallback(
    (data: T) => {
      latestDataRef.current = data;

      // Show saving indicator immediately when user starts typing
      setIsSaving(true);

      // Clear existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      // Set new timeout
      timeoutRef.current = setTimeout(async () => {
        if (latestDataRef.current !== null) {
          try {
            await callbackRef.current(latestDataRef.current);
          } catch (error) {
            console.error("Failed to save:", error);
          } finally {
            setIsSaving(false);
            latestDataRef.current = null;
          }
        } else {
          setIsSaving(false);
        }
      }, delay);
    },
    [delay]
  );

  const flush = useCallback(async () => {
    // Clear timeout and save immediately if there's pending data
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (latestDataRef.current !== null) {
      setIsSaving(true);
      try {
        await callbackRef.current(latestDataRef.current);
      } catch (error) {
        console.error("Failed to flush save:", error);
      } finally {
        setIsSaving(false);
        latestDataRef.current = null;
      }
    }
  }, []);

  const cancel = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsSaving(false);
    latestDataRef.current = null;
  }, []);

  return {
    save,
    flush,
    cancel,
    isSaving,
  };
}
