import React, { useState, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Link2, Trash2, ExternalLink } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
import useResponsive from "../app/hooks/useResponsive";
import { usePreventMobileKeyboard } from "../app/hooks/usePreventMobileKeyboard";
import { useTranslation } from "react-i18next";

interface LinkDrawerProps {
  x: number;
  y: number;
  url?: string;
  linkText?: string;
  selectedText?: string;
  onUpdate: (newUrl: string, newText: string) => void;
  onClear?: () => void;
  onClose: () => void;
  collisionBoundary?: HTMLElement | null;
  container?: HTMLElement | null;
}

export const LinkDrawer: React.FC<LinkDrawerProps> = ({
  x,
  y,
  url = "",
  linkText = "",
  selectedText = "",
  onUpdate,
  onClear,
  onClose,
  collisionBoundary,
  container,
}) => {
  const isMobile = useResponsive("(max-width: 768px)");
  const [editedUrl, setEditedUrl] = useState(url || "");
  const [editedText, setEditedText] = useState(linkText || selectedText || "");
  const { t } = useTranslation();
  // Prevent keyboard from appearing on mobile when drawer opens
  usePreventMobileKeyboard(isMobile);

  // When creating new link (no url), only require URL to be filled
  // When editing existing link (has url), require both URL and text
  const isCreatingNewLink = !url;

  useEffect(() => {
    setEditedUrl(url || "");
    setEditedText(linkText || selectedText || "");
  }, [url, linkText, selectedText]);

  const handleSubmit = () => {
    const textToUse = isCreatingNewLink ? selectedText : editedText;
    if (editedUrl.trim() && textToUse && textToUse.trim()) {
      onUpdate(editedUrl, textToUse);
      onClose();
    }
  };

  const handleClear = () => {
    if (onClear) {
      onClear();
    }
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isButtonDisabled = isCreatingNewLink
    ? !editedUrl.trim() || !selectedText
    : !editedUrl.trim() || !editedText.trim();

  // Shared content for both drawer and popover
  const content = (
    <>
      {/* Form Fields */}
      <div className="space-y-3">
        {/* Only show editable link text field when editing existing link */}
        {!isCreatingNewLink && (
          <div className="space-y-1.5">
            <label
              htmlFor="link-text"
              className="text-xs font-medium text-muted-foreground"
            >
              Link Text
            </label>
            <Input
              id="link-text"
              type="text"
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter link text"
              className="h-9"
              autoFocus={!isMobile}
            />
          </div>
        )}

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
            onChange={(e) => setEditedUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="https://example.com"
            className="h-9"
            autoFocus={isCreatingNewLink && !isMobile}
          />
        </div>

        <Button
          variant="default"
          size="sm"
          onClick={handleSubmit}
          onMouseDown={(e) => e.preventDefault()}
          disabled={isButtonDisabled}
          className="w-full"
        >
          {url ? t("editor.link.updateLink", "Update Link") : t("editor.link.addLink", "Add Link")}
        </Button>
      </div>

      {/* Actions */}
      {url && (
        <div className="flex items-center justify-between pt-2 border-t border-border">
          <button
            type="button"
            onTouchEnd={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (window.TasferBridge) {
                window.TasferBridge.navigation.openUrl(editedUrl);
              } else {
                window.open(editedUrl, "_blank", "noopener,noreferrer");
              }
            }}
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-8 px-3"
          >
            <ExternalLink className="w-4 h-4" />
            {t("editor.link.openLinkTitle", "Open Link")}
          </button>
          {onClear && (
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
          )}
        </div>
      )}
    </>
  );

  // Mobile: use Drawer
  if (isMobile) {
    return (
      <Drawer
        open={true}
        onOpenChange={(open) => !open && onClose()}
        modal={true}
        dismissible={true}
        shouldScaleBackground={false}
      >
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm">
            <DrawerHeader>
              <DrawerTitle className="flex items-center gap-2">
                <Link2 className="w-4 h-4 text-muted-foreground" />
                {url ? t("editor.link.editLinkTitle", "Edit Link") : t("editor.link.addLink", "Add Link")}
              </DrawerTitle>
            </DrawerHeader>
            <div className="space-y-4 p-4">{content}</div>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  // Desktop: use Popover
  return (
    <Popover.Root open={true} modal={false}>
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
          onEscapeKeyDown={onClose}
          onPointerDownOutside={onClose}
        >
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center gap-2 pb-2 border-b border-border">
              <Link2 className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">
                {url ? t("editor.link.editLinkTitle", "Edit Link") : t("editor.link.addLink", "Add Link")}
              </h3>
            </div>
            {content}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
