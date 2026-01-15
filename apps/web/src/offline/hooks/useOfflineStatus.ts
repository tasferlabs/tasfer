import { useState, useEffect, useCallback } from "react";
import { getMutationQueue } from "../mutation-queue";

export interface OfflineStatus {
  isOnline: boolean;
  pendingMutations: number;
  isSyncing: boolean;
  syncQueue: () => Promise<void>;
}

export function useOfflineStatus(): OfflineStatus {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [pendingMutations, setPendingMutations] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);

  const mutationQueue = getMutationQueue();

  const updatePendingCount = useCallback(async () => {
    try {
      const count = await mutationQueue.getQueueLength();
      setPendingMutations(count);
    } catch (error) {
      console.error("[useOfflineStatus] Failed to get queue length:", error);
    }
  }, [mutationQueue]);

  const syncQueue = useCallback(async () => {
    if (!navigator.onLine || isSyncing) return;

    setIsSyncing(true);
    try {
      const result = await mutationQueue.processQueue();
      console.log(
        `[useOfflineStatus] Sync completed: ${result.success} success, ${result.failed} failed`
      );
      await updatePendingCount();
    } catch (error) {
      console.error("[useOfflineStatus] Sync failed:", error);
    } finally {
      setIsSyncing(false);
    }
  }, [isSyncing, mutationQueue, updatePendingCount]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      // Auto-sync when coming back online
      syncQueue();
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    const handleServiceWorkerMessage = async (event: MessageEvent) => {
      if (event.data.type === "QUEUE_MUTATION") {
        const { url, method, body } = event.data.payload;
        await mutationQueue.enqueue(url, method, body);
        await updatePendingCount();
      } else if (event.data.type === "PROCESS_MUTATION_QUEUE") {
        await syncQueue();
      }
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    navigator.serviceWorker?.addEventListener(
      "message",
      handleServiceWorkerMessage
    );

    // Initial count
    updatePendingCount();

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      navigator.serviceWorker?.removeEventListener(
        "message",
        handleServiceWorkerMessage
      );
    };
  }, [syncQueue, updatePendingCount, mutationQueue]);

  return { isOnline, pendingMutations, isSyncing, syncQueue };
}
