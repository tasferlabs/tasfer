import React, { useState, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useTranslation } from "react-i18next";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Link2, Trash2 } from "lucide-react";

interface LinkEditPopoverProps {
  x: number;
  y: number;
  url: string;
  linkText: string;
  onUpdate: (newUrl: string, newText: string) => void;
  onClear: () => void;
  onClose: () => void;
  collisionBoundary?: HTMLElement | null;
  container?: HTMLElement | null;
}

export const LinkEditPopover: React.FC<LinkEditPopoverProps> = ({
  x,
  y,
  url,
  linkText,
  onUpdate,
  onClear,
  onClose,
  collisionBoundary,
  container,
}) => {
  const { t } = useTranslation();
  const [editedUrl, setEditedUrl] = useState(url);
  const [editedText, setEditedText] = useState(linkText);

  useEffect(() => {
    setEditedUrl(url);
    setEditedText(linkText);
  }, [url, linkText]);

  const handleUrlChange = (newUrl: string) => {
    setEditedUrl(newUrl);
    onUpdate(newUrl, editedText);
  };

  const handleTextChange = (newText: string) => {
    setEditedText(newText);
    onUpdate(editedUrl, newText);
  };

  const handleClear = () => {
    onClear();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <Popover.Root open={true} onOpenChange={(open) => !open && onClose()}>
      <Popover.Anchor
        style={{
          position: "fixed",
          left: `${x}px`,
          top: `${y}px`,
          width: 1,
          height: 1,
        }}
      />
      <Popover.Portal container={container}>
        <Popover.Content
          className="bg-popover border border-border rounded-lg shadow-lg p-4 min-w-[320px] max-w-[400px] z-50 select-none pointer-events-auto animate-in fade-in zoom-in-95 duration-150"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionBoundary={collisionBoundary}
          collisionPadding={10}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center gap-2 pb-2 border-b border-border">
              <Link2 className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">
                {t("editor.link.editLinkTitle", "Edit Link")}
              </h3>
            </div>

            {/* Form Fields */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="link-text"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("editor.link.linkText", "Link Text")}
                </label>
                <Input
                  id="link-text"
                  type="text"
                  value={editedText}
                  onChange={(e) => handleTextChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t("editor.link.enterText", "Enter link text")}
                  className="h-9"
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="link-url"
                  className="text-xs font-medium text-muted-foreground"
                >
                  URL
                </label>
                <Input
                  id="link-url"
                  type="url"
                  value={editedUrl}
                  onChange={(e) => handleUrlChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="https://example.com"
                  className="h-9"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-start pt-2 border-t border-border">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClear}
                onMouseDown={(e) => e.preventDefault()}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="w-4 h-4 me-2" />
                {t("editor.link.clearLink", "Clear Link")}
              </Button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
