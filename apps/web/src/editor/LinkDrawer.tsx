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
import useMobileLayout from "../app/hooks/useMobileLayout";
import { usePreventMobileKeyboard } from "../app/hooks/usePreventMobileKeyboard";
import { useOpenExternalUrl } from "../app/components/ExternalLinkDialog";
import { useTranslation } from "react-i18next";

interface LinkDrawerProps {
  x: number;
  y: number;
  url?: string;
  selectedText?: string;
  onUpdate: (newUrl: string) => void;
  onClear?: () => void;
  onClose: () => void;
  collisionBoundary?: HTMLElement | null;
  container?: HTMLElement | null;
}

export const LinkDrawer: React.FC<LinkDrawerProps> = ({
  x,
  y,
  url = "",
  selectedText = "",
  onUpdate,
  onClear,
  onClose,
  collisionBoundary,
  container,
}) => {
  const { isMobile } = useMobileLayout();
  const [editedUrl, setEditedUrl] = useState(url || "");
  const { t } = useTranslation();
  const openExternalUrl = useOpenExternalUrl();
  // Prevent keyboard from appearing on mobile when drawer opens
  usePreventMobileKeyboard(isMobile);

  const isCreatingNewLink = !url;

  useEffect(() => {
    setEditedUrl(url || "");
  }, [url]);

  const handleSubmit = () => {
    if (editedUrl.trim() && (!isCreatingNewLink || selectedText)) {
      onUpdate(editedUrl);
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
      // The field is shared with the desktop popover, where Escape dismisses.
      // In the drawer it is a dismissal like any other and must not discard
      // typing — see `dirty` on the `Drawer` below.
      if (isMobile && hasUnappliedUrl) return;
      onClose();
    } else if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isButtonDisabled =
    !editedUrl.trim() || (isCreatingNewLink && !selectedText);

  // A URL typed but not applied yet. The mobile drawer holds itself open while
  // this is true, so a swipe or a backdrop tap cannot discard the typing.
  const hasUnappliedUrl = editedUrl.trim() !== url.trim();

  // Shared content for both drawer and popover
  const content = (
    <>
      {/* Form Fields */}
      <div className="space-y-3">
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
            autoFocus={!isMobile}
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
              // The field's live value, so this previews what is being typed —
              // still protocol-checked and confirmed like any other open.
              openExternalUrl(editedUrl);
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
        dirty={hasUnappliedUrl}
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
            <div className="space-y-4 p-4">
              {content}
              {/* The swipe is blocked while the field is dirty, so leaving has
                  to be something the user asks for. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="w-full"
              >
                {t("common.cancel", "Cancel")}
              </Button>
            </div>
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
