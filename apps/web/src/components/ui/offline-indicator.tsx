import { WifiOff, CloudOff, RefreshCw } from "lucide-react";
import { useOfflineStatus } from "@/offline/hooks/useOfflineStatus";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "framer-motion";

export function OfflineIndicator() {
  const { isOnline, pendingMutations, isSyncing, syncQueue } =
    useOfflineStatus();

  // Don't show anything when online with no pending mutations
  if (isOnline && pendingMutations === 0) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        className={cn(
          "fixed bottom-4 left-4 flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg z-50",
          "text-sm font-medium",
          isOnline
            ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
            : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
        )}
      >
        {!isOnline && (
          <>
            <WifiOff className="w-4 h-4" />
            <span>Offline</span>
          </>
        )}

        {pendingMutations > 0 && (
          <>
            {isOnline && <CloudOff className="w-4 h-4" />}
            <span>
              {pendingMutations} pending{" "}
              {pendingMutations === 1 ? "change" : "changes"}
            </span>

            {isOnline && (
              <button
                onClick={syncQueue}
                disabled={isSyncing}
                className={cn(
                  "ml-1 p-1 rounded transition-colors",
                  "hover:bg-yellow-200 dark:hover:bg-yellow-800"
                )}
                title="Sync now"
              >
                <RefreshCw
                  className={cn("w-4 h-4", isSyncing && "animate-spin")}
                />
              </button>
            )}
          </>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
