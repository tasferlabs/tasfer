/**
 * DevToolbar
 *
 * Floating toolbar for development/staging environments.
 * Only renders when VITE_STAGING env var is set to "true".
 */

import { useState, useCallback } from "react";
import { Switch } from "@/components/ui/switch";
import { useWebSocket } from "@/app/contexts/WebSocketContext";
import { cn } from "@/lib/utils";

// Only show in staging environment
const isStaging = import.meta.env.VITE_STAGING === "true";

export function DevToolbar() {
  const { disconnect, reconnect, connectionState } = useWebSocket();
  const [networkLoss, setNetworkLoss] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isHidden, setIsHidden] = useState(false);

  const handleNetworkLossToggle = useCallback(
    (checked: boolean) => {
      setNetworkLoss(checked);
      if (checked) {
        disconnect();
      } else {
        reconnect();
      }
    },
    [disconnect, reconnect],
  );

  // Don't render if not in staging or hidden
  if (!isStaging || isHidden) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed bottom-4 right-4 z-[9999]",
        "bg-popover backdrop-blur-xl",
        "border border-border rounded-lg",
        "shadow-lg",
        "transition-all duration-200 ease-out",
        "font-sans text-sm",
        isExpanded ? "w-64" : "w-auto",
      )}
    >
      {/* Header / Toggle Button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "flex items-center gap-2 px-3 py-2 w-full",
          "text-foreground hover:text-foreground",
          "transition-colors",
        )}
      >
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "w-2 h-2 rounded-full",
              connectionState === "connected"
                ? networkLoss
                  ? "bg-amber-500"
                  : "bg-emerald-500"
                : "bg-red-500",
              "animate-pulse",
            )}
          />
          <span className="font-medium text-xs uppercase tracking-wider">
            Dev
          </span>
        </div>
        <svg
          className={cn(
            "w-3.5 h-3.5 ml-auto transition-transform",
            isExpanded && "rotate-180",
          )}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5 15l7-7 7 7"
          />
        </svg>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
          {/* Network Loss Toggle */}
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <span className="text-foreground text-xs font-medium">
                Network Loss
              </span>
              <span className="text-muted-foreground text-[10px]">
                Simulate offline mode
              </span>
            </div>
            <Switch
              checked={networkLoss}
              onCheckedChange={handleNetworkLossToggle}
              size="sm"
              className="data-[state=checked]:bg-amber-500"
            />
          </div>

          {/* Hide toolbar */}
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <span className="text-foreground text-xs font-medium">
                Hide Toolbar
              </span>
              <span className="text-muted-foreground text-[10px]">
                Until next reload
              </span>
            </div>
            <button
              onClick={() => setIsHidden(true)}
              className={cn(
                "px-2 py-1 text-[10px]",
                "text-muted-foreground hover:text-foreground",
                "border border-border rounded",
                "hover:bg-muted transition-colors",
              )}
            >
              Hide
            </button>
          </div>

          {/* Connection Status */}
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <span className="text-muted-foreground text-[10px]">Status</span>
            <span
              className={cn(
                "text-[10px] font-medium uppercase tracking-wider",
                connectionState === "connected"
                  ? "text-emerald-500"
                  : connectionState === "connecting"
                    ? "text-amber-500"
                    : "text-red-500",
              )}
            >
              {networkLoss ? "Offline (simulated)" : connectionState}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
