import { Edit2, ExternalLink } from "lucide-react";
import React from "react";
import { cn } from "../lib/utils";

interface LinkTooltipProps {
  url: string;
  linkText: string;
  x: number;
  y: number;
  onEdit?: () => void;
  onOpen?: () => void;
}

export const LinkTooltip: React.FC<LinkTooltipProps> = ({
  url,
  linkText,
  x,
  y,
  onEdit,
  onOpen,
}) => {
  const handleOpen = () => {
    if (onOpen) {
      onOpen();
    } else {
      // Default behavior: open in new tab
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div
      className="fixed z-50 pointer-events-auto select-none"
      style={{
        left: x,
        top: y,
        transform: "translateY(4px)",
      }}
      onMouseEnter={(e) => e.stopPropagation()}
      onMouseLeave={(e) => e.stopPropagation()}
    >
      <div className="bg-popover border border-border rounded-lg shadow-lg overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150 pointer-events-auto">
        {/* Link Preview */}
        <div className="px-3 py-2 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2 text-sm">
            <ExternalLink className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <span className="text-foreground/80 truncate max-w-[280px] font-medium">
              {linkText}
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground truncate max-w-[280px]">
            {url}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center p-1">
          <button
            onClick={handleOpen}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 text-sm rounded-md",
              "hover:bg-accent hover:text-accent-foreground",
              "transition-colors duration-150",
              "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
            )}
            title="Open link"
          >
            <ExternalLink className="w-4 h-4" />
            <span>Open</span>
          </button>

          {onEdit && (
            <button
              onClick={onEdit}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 text-sm rounded-md",
                "hover:bg-accent hover:text-accent-foreground",
                "transition-colors duration-150",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
              )}
              title="Edit link"
            >
              <Edit2 className="w-4 h-4" />
              <span>Edit</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
