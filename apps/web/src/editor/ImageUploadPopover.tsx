import React, { useState, useRef } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Image as ImageIcon, Upload, Trash2, Loader2, Link2 } from "lucide-react";

interface ImageUploadPopoverProps {
  x: number;
  y: number;
  onUpload: (file: File) => void;
  onUrlSubmit?: (url: string) => void;
  onDelete?: () => void;
  onClose: () => void;
  uploadStatus?: 'idle' | 'uploading' | 'complete' | 'error';
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
  uploadStatus = 'idle',
  existingUrl,
  existingAlt,
  collisionBoundary,
  container,
}) => {
  const [imageUrl, setImageUrl] = useState(existingUrl || "");
  const [uploadMode, setUploadMode] = useState<'file' | 'url'>(existingUrl ? 'url' : 'file');
  const [previewUrl, setPreviewUrl] = useState<string | null>(existingUrl || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Create preview
      const reader = new FileReader();
      reader.onload = (event) => {
        setPreviewUrl(event.target?.result as string);
      };
      reader.readAsDataURL(file);
      
      // Upload file
      onUpload(file);
    }
  };

  const handleUrlSubmit = () => {
    if (imageUrl.trim() && onUrlSubmit) {
      setPreviewUrl(imageUrl);
      onUrlSubmit(imageUrl);
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
    } else if (e.key === "Enter" && uploadMode === 'url') {
      e.preventDefault();
      handleUrlSubmit();
    }
  };

  const triggerFilePicker = () => {
    fileInputRef.current?.click();
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
              <ImageIcon className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">
                {existingUrl ? 'Edit Image' : 'Add Image'}
              </h3>
            </div>

            {/* Mode Toggle */}
            <div className="flex gap-2 p-1 bg-muted rounded-md">
              <button
                onClick={() => setUploadMode('file')}
                className={`flex-1 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  uploadMode === 'file'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Upload className="w-3 h-3 inline mr-1.5" />
                Upload
              </button>
              <button
                onClick={() => setUploadMode('url')}
                className={`flex-1 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  uploadMode === 'url'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Link2 className="w-3 h-3 inline mr-1.5" />
                URL
              </button>
            </div>

            {/* Upload Area */}
            {uploadMode === 'file' ? (
              <div className="space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,image/gif,image/webp,image/svg+xml"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                
                {previewUrl && uploadStatus !== 'error' ? (
                  <div className="relative rounded-lg overflow-hidden border border-border">
                    <img
                      src={previewUrl}
                      alt="Preview"
                      className="w-full h-48 object-cover"
                    />
                    {uploadStatus === 'uploading' && (
                      <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                        <Loader2 className="w-8 h-8 text-white animate-spin" />
                      </div>
                    )}
                    {uploadStatus === 'complete' && (
                      <div className="absolute top-2 right-2 bg-green-500 text-white text-xs px-2 py-1 rounded">
                        ✓ Uploaded
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={triggerFilePicker}
                    disabled={uploadStatus === 'uploading'}
                    className="w-full h-32 border-2 border-dashed border-border rounded-lg hover:border-primary hover:bg-accent/50 transition-colors flex flex-col items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {uploadStatus === 'uploading' ? (
                      <>
                        <Loader2 className="w-8 h-8 text-muted-foreground animate-spin" />
                        <span className="text-sm text-muted-foreground">Uploading...</span>
                      </>
                    ) : uploadStatus === 'error' ? (
                      <>
                        <div className="w-8 h-8 text-destructive">⚠</div>
                        <span className="text-sm text-destructive">Upload failed. Click to retry</span>
                      </>
                    ) : (
                      <>
                        <Upload className="w-8 h-8 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">Click to upload image</span>
                        <span className="text-xs text-muted-foreground">JPG, PNG, GIF, WebP, or SVG</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            ) : (
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
                    autoFocus
                  />
                </div>

                {imageUrl && (
                  <div className="rounded-lg overflow-hidden border border-border">
                    <img
                      src={imageUrl}
                      alt="Preview"
                      className="w-full h-48 object-cover"
                      onError={(e) => {
                        e.currentTarget.src = '';
                        e.currentTarget.className = 'w-full h-48 bg-muted flex items-center justify-center text-muted-foreground text-sm';
                        e.currentTarget.alt = 'Failed to load image';
                      }}
                    />
                  </div>
                )}

                <Button
                  variant="default"
                  size="sm"
                  onClick={handleUrlSubmit}
                  disabled={!imageUrl.trim()}
                  className="w-full"
                >
                  Add Image
                </Button>
              </div>
            )}

            {/* Actions */}
            {(existingUrl || uploadStatus === 'complete') && (
              <div className="flex items-center justify-start pt-2 border-t border-border">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDelete}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Remove Image
                </Button>
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

