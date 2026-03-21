import { Edit2, ExternalLink } from "lucide-react";
import React, { useRef, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y, transform: "translateY(4px)" });

  useLayoutEffect(() => {
    if (!tooltipRef.current) return;

    const tooltip = tooltipRef.current;
    const rect = tooltip.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const PADDING = 8; // Padding from viewport edges
    const LINK_HEIGHT = 24; // Approximate height of the link element

    let finalX = x;
    let finalY = y;
    let transformY = 4; // Default: position below the link

    // Check if tooltip goes below viewport
    if (y + rect.height + PADDING > viewportHeight) {
      // Position above the link instead
      transformY = -(rect.height + LINK_HEIGHT);
    }

    // Check horizontal boundaries
    if (x + rect.width + PADDING > viewportWidth) {
      finalX = viewportWidth - rect.width - PADDING;
    }
    if (x < PADDING) {
      finalX = PADDING;
    }

    setPosition({
      x: finalX,
      y: finalY,
      transform: `translateY(${transformY}px)`,
    });
  }, [x, y]);

  const handleOpen = () => {
    if (onOpen) {
      onOpen();
    } else {
      if (window.CypherBridge) {
        window.CypherBridge.navigation.openUrl(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    }
  };

  return (
    <div
      ref={tooltipRef}
      className="fixed z-50 pointer-events-auto select-none"
      style={{
        left: position.x,
        top: position.y,
        transform: position.transform,
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
            onMouseDown={(e) => e.preventDefault()}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 text-sm rounded-md",
              "hover:bg-accent hover:text-accent-foreground",
              "transition-colors duration-150",
              "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
            )}
            title={t("editor.link.openLink", "Open link")}
          >
            <ExternalLink className="w-4 h-4" />
            <span>{t("common.open", "Open")}</span>
          </button>

          {onEdit && (
            <button
              onClick={onEdit}
              onMouseDown={(e) => e.preventDefault()}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 text-sm rounded-md",
                "hover:bg-accent hover:text-accent-foreground",
                "transition-colors duration-150",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
              )}
              title={t("editor.link.editLink", "Edit link")}
            >
              <Edit2 className="w-4 h-4" />
              <span>{t("common.edit", "Edit")}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
