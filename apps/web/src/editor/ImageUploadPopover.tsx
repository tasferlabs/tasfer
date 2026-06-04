import React, { useState, useRef, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import {
  Image as ImageIcon,
  Upload,
  Trash2,
  Loader2,
  Link2,
  Camera,
  FolderOpen,
} from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
import useResponsive from "../app/hooks/useResponsive";
import { usePreventMobileKeyboard } from "../app/hooks/usePreventMobileKeyboard";
import { hasNativeBridge } from "@cypherkit/editor/actions/clipboard";
import { useTranslation } from "react-i18next";

interface ImageUploadPopoverProps {
  x: number;
  y: number;
  onUpload: (file: File) => void;
  onUrlSubmit?: (url: string) => void;
  onDelete?: () => void;
  onClose: () => void;
  uploadStatus?: "idle" | "uploading" | "complete" | "error";
  existingUrl?: string;
  existingAlt?: string;
  collisionBoundary?: HTMLElement | null;
  container?: HTMLElement | null;
}

export const ImageUploadPopover: React.FC<ImageUploadPopoverProps> = ({
  x,
  y,
  onUpload,
  onUrlSubmit,
  onDelete,
  onClose,
  uploadStatus = "idle",
  existingUrl,
  existingAlt: _existingAlt,
  collisionBoundary,
  container,
}) => {
  const { t } = useTranslation();
  const isMobile = useResponsive("(max-width: 768px)");
  const [imageUrl, setImageUrl] = useState(existingUrl || "");
  // On mobile, always default to 'file' mode to avoid keyboard appearing
  const [uploadMode, setUploadMode] = useState<"file" | "url">(
    isMobile ? "file" : existingUrl ? "url" : "file"
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Prevent keyboard from appearing on mobile when drawer opens
  usePreventMobileKeyboard(isMobile);

  // Listen for native image selection
  useEffect(() => {
    const handleNativeImageSelected = (event: MessageEvent) => {
      if (event.data?.type === "native-image-selected") {
        const dataUrl = event.data.dataUrl;

        if (!dataUrl) return;

        // Convert data URL to File object
        fetch(dataUrl)
          .then((res) => res.blob())
          .then((blob) => {
            const file = new File([blob], "image.jpg", { type: blob.type });

            // Upload file directly without preview
            // Don't close — the upload completion handler will dismiss
            onUpload(file);
          })
          .catch((error) => {
            console.error("Failed to process native image:", error);
          });
      }
    };

    if (hasNativeBridge()) {
      window.addEventListener("message", handleNativeImageSelected);

      return () => {
        window.removeEventListener("message", handleNativeImageSelected);
      };
    }
  }, [onUpload, onClose]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Upload file directly without preview
      // Don't close — the popover will be dismissed by the upload completion handler
      onUpload(file);
    }
  };

  const handleUrlSubmit = () => {
    if (imageUrl.trim() && onUrlSubmit) {
      onUrlSubmit(imageUrl);
      // Close the popover after submitting
      setTimeout(() => {
        onClose();
      }, 300);
    }
  };

  const handleDelete = () => {
    if (onDelete) {
      onDelete();
    }
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && uploadMode === "url") {
      e.preventDefault();
      handleUrlSubmit();
    }
  };

  const triggerFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleOpenLibrary = () => {
    window.CypherBridge?.navigation.openPhotoLibrary();
  };

  const handleOpenCamera = () => {
    window.CypherBridge?.navigation.openCamera();
  };

  const isNative = hasNativeBridge();

  // Shared content for both drawer and popover
  const content = (
    <>
      {/* Mode Toggle - Only show on non-native platforms */}
      {!isNative && (
        <div className="flex gap-2 p-1 bg-muted rounded-md">
          <button
            onClick={() => setUploadMode("file")}
            onMouseDown={(e) => e.preventDefault()}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              uploadMode === "file"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Upload className="w-3 h-3 inline me-1.5" />
            Upload
          </button>
          <button
            onClick={() => setUploadMode("url")}
            onMouseDown={(e) => e.preventDefault()}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              uploadMode === "url"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Link2 className="w-3 h-3 inline me-1.5" />
            URL
          </button>
        </div>
      )}

      {/* Upload Area */}
      {isNative ? (
        // Native platform: Show photo library and camera buttons
        <div className="space-y-2">
          {uploadStatus === "uploading" ? (
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="w-12 h-12 text-primary animate-spin mb-2" />
              <span className="text-sm text-muted-foreground">
                Uploading...
              </span>
            </div>
          ) : (
            <>
              <Button
                variant="outline"
                size="lg"
                onClick={handleOpenLibrary}
                onMouseDown={(e) => e.preventDefault()}
                className="w-full h-16"
              >
                <FolderOpen className="w-5 h-5 me-3" />
                <span className="text-base">Open Library</span>
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={handleOpenCamera}
                onMouseDown={(e) => e.preventDefault()}
                className="w-full h-16"
              >
                <Camera className="w-5 h-5 me-3" />
                <span className="text-base">Take Photo</span>
              </Button>
            </>
          )}
        </div>
      ) : uploadMode === "file" ? (
        // Web platform: Show file upload
        <div className="space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp,image/svg+xml"
            onChange={handleFileSelect}
            className="hidden"
          />

          <button
            onClick={triggerFilePicker}
            onMouseDown={(e) => e.preventDefault()}
            disabled={uploadStatus === "uploading"}
            className="w-full h-32 border-2 border-dashed border-border rounded-lg hover:border-primary hover:bg-accent/50 transition-colors flex flex-col items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {uploadStatus === "uploading" ? (
              <>
                <Loader2 className="w-8 h-8 text-muted-foreground animate-spin" />
                <span className="text-sm text-muted-foreground">
                  Uploading...
                </span>
              </>
            ) : uploadStatus === "error" ? (
              <>
                <div className="w-8 h-8 text-destructive">⚠</div>
                <span className="text-sm text-destructive">
                  Upload failed. Click to retry
                </span>
              </>
            ) : (
              <>
                <Upload className="w-8 h-8 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  Click to upload image
                </span>
                <span className="text-xs text-muted-foreground">
                  JPG, PNG, GIF, WebP, or SVG
                </span>
              </>
            )}
          </button>
        </div>
      ) : (
        // Web platform: Show URL upload
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label
              htmlFor="image-url"
              className="text-xs font-medium text-muted-foreground"
            >
              Image URL
            </label>
            <Input
              id="image-url"
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="https://example.com/image.jpg"
              className="h-9"
            />
          </div>

          <Button
            variant="default"
            size="sm"
            onClick={handleUrlSubmit}
            onMouseDown={(e) => e.preventDefault()}
            disabled={!imageUrl.trim()}
            className="w-full"
          >
            {existingUrl ? t("image.updateImage", "Update Image") : t("image.addImage", "Add Image")}
          </Button>
        </div>
      )}

      {/* Actions */}
      {(existingUrl || uploadStatus === "complete") && (
        <div className="flex items-center justify-start pt-2 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            onMouseDown={(e) => e.preventDefault()}
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="w-4 h-4 me-2" />
            Remove Image
          </Button>
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
        <DrawerContent
          onOpenAutoFocus={(e) => {
            // Prevent any focus when drawer opens
            e.preventDefault();
          }}
          onPointerDown={(e) => {
            // Prevent focus on any pointer interaction with the drawer
            const target = e.target as HTMLElement;
            // Only blur if not clicking on an actual input/button we want to interact with
            if (!target.matches("input, button, a")) {
              if (
                document.activeElement instanceof HTMLElement &&
                document.activeElement.getAttribute("aria-hidden") === "true"
              ) {
                document.activeElement.blur();
              }
            }
          }}
        >
          <div className="mx-auto w-full max-w-sm">
            <DrawerHeader>
              <DrawerTitle className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-muted-foreground" />
                {existingUrl ? "Edit Image" : "Add Image"}
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
              <ImageIcon className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">
                {existingUrl ? "Edit Image" : "Add Image"}
              </h3>
            </div>
            {content}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
