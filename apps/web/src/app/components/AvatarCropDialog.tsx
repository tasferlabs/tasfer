import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getCroppedImage } from "@/lib/cropImage";
import React from "react";
import Cropper, { type Area } from "react-easy-crop";
import { useTranslation } from "react-i18next";

interface AvatarCropDialogProps {
  file: File | null;
  onCropped: (file: File) => void;
  onCancel: () => void;
}

export function AvatarCropDialog({
  file,
  onCropped,
  onCancel,
}: AvatarCropDialogProps) {
  const { t } = useTranslation();
  const [crop, setCrop] = React.useState({ x: 0, y: 0 });
  const [zoom, setZoom] = React.useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = React.useState<Area | null>(
    null,
  );
  const [imageSrc, setImageSrc] = React.useState<string | null>(null);
  const [cropping, setCropping] = React.useState(false);

  React.useEffect(() => {
    if (!file) {
      setImageSrc(null);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setCroppedAreaPixels(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setImageSrc(url);

    return () => URL.revokeObjectURL(url);
  }, [file]);

  function handleCropComplete(_: Area, croppedPixels: Area) {
    setCroppedAreaPixels(croppedPixels);
  }

  async function handleConfirm() {
    if (!imageSrc || !croppedAreaPixels) return;

    try {
      setCropping(true);
      const croppedFile = await getCroppedImage(imageSrc, croppedAreaPixels);
      onCropped(croppedFile);
    } catch (err) {
      console.error("Failed to crop image:", err);
    } finally {
      setCropping(false);
    }
  }

  return (
    <Dialog
      open={!!file}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("profile.cropAvatar", "Crop avatar")}</DialogTitle>
        </DialogHeader>

        <div className="relative w-full" style={{ aspectRatio: "1" }}>
          {imageSrc && (
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="round"
              showGrid={false}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={handleCropComplete}
            />
          )}
        </div>

        <div className="flex items-center gap-3 px-1">
          <span className="text-sm text-muted-foreground shrink-0">
            {t("common.zoom", "Zoom")}
          </span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full accent-primary"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={cropping}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button onClick={handleConfirm} loading={cropping}>
            {t("common.crop", "Crop")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
