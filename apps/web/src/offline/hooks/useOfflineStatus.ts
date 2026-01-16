import { useEffect, useCallback, useRef } from "react";
import { getMutationQueue } from "../mutation-queue";

/**
 * Hook to handle offline mutation queueing and auto-sync.
 * Runs silently in the background - no UI state exposed.
 */
export function useOfflineStatus(): void {
  const mutationQueue = getMutationQueue();
  const isSyncingRef = useRef(false);

  const syncQueue = useCallback(async () => {
    if (!navigator.onLine || isSyncingRef.current) return;

    isSyncingRef.current = true;
    try {
      await mutationQueue.processQueue();
    } catch (error) {
      console.error("[useOfflineStatus] Sync failed:", error);
    } finally {
      isSyncingRef.current = false;
    }
  }, [mutationQueue]);

  useEffect(() => {
    const handleOnline = () => syncQueue();

    const handleServiceWorkerMessage = async (event: MessageEvent) => {
      if (event.data.type === "QUEUE_MUTATION") {
        const { url, method, body } = event.data.payload;
        await mutationQueue.enqueue(url, method, body);
      } else if (event.data.type === "PROCESS_MUTATION_QUEUE") {
        await syncQueue();
      }
    };

    window.addEventListener("online", handleOnline);
    navigator.serviceWorker?.addEventListener(
      "message",
      handleServiceWorkerMessage
    );

    // Sync any pending mutations on mount
    syncQueue();

    return () => {
      window.removeEventListener("online", handleOnline);
      navigator.serviceWorker?.removeEventListener(
        "message",
        handleServiceWorkerMessage
      );
    };
  }, [syncQueue, mutationQueue]);
}
