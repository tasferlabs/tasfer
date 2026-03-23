import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Html5Qrcode } from "html5-qrcode";
import { Camera, X } from "lucide-react";

interface QRScannerViewProps {
  onScan: (data: string) => void;
  onClose: () => void;
}

export function QRScannerView({ onScan, onClose }: QRScannerViewProps) {
  const { t } = useTranslation();
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const hasScannedRef = useRef(false);
  const isRunningRef = useRef(false);

  const startScanner = useCallback(async () => {
    if (!containerRef.current) return;

    try {
      const scanner = new Html5Qrcode("qr-reader", { verbose: false });
      scannerRef.current = scanner;

      const cameras = await Html5Qrcode.getCameras();
      if (cameras.length === 0) {
        setError(t("scanner.noCamera", "No camera found on this device"));
        return;
      }

      // Prefer back camera on mobile
      const backCamera = cameras.find(
        (c) =>
          c.label.toLowerCase().includes("back") ||
          c.label.toLowerCase().includes("rear") ||
          c.label.toLowerCase().includes("environment"),
      );
      const cameraId = backCamera ? backCamera.id : cameras[0].id;

      await scanner.start(
        cameraId,
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
          aspectRatio: 1,
        },
        (decodedText) => {
          if (hasScannedRef.current) return;
          hasScannedRef.current = true;
          onScan(decodedText);
        },
        () => {
          // ignore scan failures (no QR in frame)
        },
      );

      isRunningRef.current = true;
      setReady(true);
    } catch (err) {
      if (err instanceof Error && err.message.includes("Permission")) {
        setError(
          t(
            "scanner.permissionDenied",
            "Camera permission denied. Please allow camera access to scan QR codes.",
          ),
        );
      } else {
        setError(
          t(
            "scanner.cameraError",
            "Could not access camera. Make sure no other app is using it.",
          ),
        );
      }
    }
  }, [onScan, t]);

  useEffect(() => {
    startScanner();

    return () => {
      const scanner = scannerRef.current;
      if (scanner && isRunningRef.current) {
        isRunningRef.current = false;
        scanner
          .stop()
          .then(() => scanner.clear())
          .catch(() => {});
      }
    };
  }, [startScanner]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-8">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
          <Camera className="h-6 w-6 text-destructive" />
        </div>
        <p className="text-sm text-destructive text-center px-4">{error}</p>
        <button
          type="button"
          onClick={onClose}
          className="text-sm font-medium text-primary hover:text-primary/80 transition-colors"
        >
          {t("common.back", "Back")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Scanner container */}
      <div className="relative w-full overflow-hidden rounded-xl" ref={containerRef}>
        {/* Camera feed — html5-qrcode renders into this div */}
        <div
          id="qr-reader"
          className="qr-scanner-container w-full"
          style={{ minHeight: 280 }}
        />

        {/* Viewfinder overlay */}
        {ready && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {/* Dimmed corners */}
            <div className="absolute inset-0 bg-black/40" />

            {/* Clear center cutout */}
            <div className="relative h-[250px] w-[250px]">
              {/* Cutout (clear area) */}
              <div className="absolute inset-0 rounded-2xl bg-black/40 ring-2 ring-white/20" style={{
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.4)",
                background: "transparent",
              }} />

              {/* Corner markers */}
              <Corner position="top-left" />
              <Corner position="top-right" />
              <Corner position="bottom-left" />
              <Corner position="bottom-right" />
            </div>
          </div>
        )}

        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 end-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Hint text */}
      <p className="text-xs text-muted-foreground text-center">
        {t("scanner.pointAtQR", "Point your camera at a QR code")}
      </p>
    </div>
  );
}

/** Corner bracket markers for the viewfinder */
function Corner({ position }: { position: "top-left" | "top-right" | "bottom-left" | "bottom-right" }) {
  const isTop = position.includes("top");
  const isLeft = position.includes("left");

  return (
    <div
      className="absolute h-6 w-6"
      style={{
        top: isTop ? -1 : undefined,
        bottom: !isTop ? -1 : undefined,
        left: isLeft ? -1 : undefined,
        right: !isLeft ? -1 : undefined,
      }}
    >
      {/* Horizontal bar */}
      <div
        className="absolute h-[3px] w-6 rounded-full bg-primary"
        style={{
          top: isTop ? 0 : undefined,
          bottom: !isTop ? 0 : undefined,
        }}
      />
      {/* Vertical bar */}
      <div
        className="absolute h-6 w-[3px] rounded-full bg-primary"
        style={{
          top: isTop ? 0 : undefined,
          bottom: !isTop ? 0 : undefined,
          left: isLeft ? 0 : undefined,
          right: !isLeft ? 0 : undefined,
        }}
      />
    </div>
  );
}
