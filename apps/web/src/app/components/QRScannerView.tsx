import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CameraDevice,
  Html5Qrcode as Html5QrcodeInstance,
} from "html5-qrcode";
import { Camera, SwitchCamera, X } from "lucide-react";

interface QRScannerViewProps {
  onScan: (data: string) => void;
  onClose: () => void;
  hideClose?: boolean;
}

export function QRScannerView({
  onScan,
  onClose,
  hideClose,
}: QRScannerViewProps) {
  const { t } = useTranslation();
  const reactId = useId();
  const scannerId = `qr-reader-${reactId.replace(/:/g, "")}`;
  const scannerRef = useRef<Html5QrcodeInstance | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const camerasRef = useRef<CameraDevice[]>([]);
  const activeCameraIdRef = useRef<string | null>(null);
  const onScanRef = useRef(onScan);
  const tRef = useRef(t);
  const mountedRef = useRef(false);
  const switchingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [cameraCount, setCameraCount] = useState(0);
  const [switching, setSwitching] = useState(false);
  const hasScannedRef = useRef(false);
  const isRunningRef = useRef(false);
  onScanRef.current = onScan;
  tRef.current = t;

  function startCamera(scanner: Html5QrcodeInstance, cameraId: string) {
    return scanner.start(
      cameraId,
      {
        fps: 10,
        qrbox: { width: 250, height: 250 },
        aspectRatio: 1,
      },
      (decodedText) => {
        if (hasScannedRef.current) return;
        hasScannedRef.current = true;
        onScanRef.current(decodedText);
      },
      () => {
        // Ignore scan failures while there is no QR code in the frame.
      },
    );
  }

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;

    async function startScanner() {
      if (!containerRef.current) return;

      let scanner: Html5QrcodeInstance | null = null;
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (cancelled) return;
        scanner = new Html5Qrcode(scannerId, { verbose: false });
        scannerRef.current = scanner;

        const cameras = await Html5Qrcode.getCameras();

        // Effect was cleaned up while awaiting — stop immediately and bail
        if (cancelled) {
          scanner.clear();
          return;
        }

        if (cameras.length === 0) {
          setError(
            tRef.current("scanner.noCamera", "No camera found on this device"),
          );
          return;
        }

        camerasRef.current = cameras;
        setCameraCount(cameras.length);

        // Prefer back camera on mobile
        const backCamera = cameras.find(
          (c) =>
            c.label.toLowerCase().includes("back") ||
            c.label.toLowerCase().includes("rear") ||
            c.label.toLowerCase().includes("environment"),
        );
        const cameraId = backCamera ? backCamera.id : cameras[0].id;

        await startCamera(scanner, cameraId);

        // Effect was cleaned up while the camera was starting — stop it now
        if (cancelled) {
          scanner
            .stop()
            .then(() => scanner!.clear())
            .catch(() => {});
          return;
        }

        isRunningRef.current = true;
        activeCameraIdRef.current = cameraId;
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.message.includes("Permission")) {
          setError(
            tRef.current(
              "scanner.permissionDenied",
              "Camera permission denied. Please allow camera access to scan QR codes.",
            ),
          );
        } else {
          setError(
            tRef.current(
              "scanner.cameraError",
              "Could not access camera. Make sure no other app is using it.",
            ),
          );
        }
      }
    }

    startScanner();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      const scanner = scannerRef.current;
      if (scanner && isRunningRef.current) {
        isRunningRef.current = false;
        scanner
          .stop()
          .then(() => scanner.clear())
          .catch(() => {});
      }
    };
  }, [scannerId]);

  async function handleSwitchCamera() {
    const scanner = scannerRef.current;
    const cameras = camerasRef.current;
    const activeCameraId = activeCameraIdRef.current;
    if (
      !scanner ||
      cameras.length < 2 ||
      !activeCameraId ||
      switchingRef.current
    ) {
      return;
    }

    const activeIndex = cameras.findIndex(
      (camera) => camera.id === activeCameraId,
    );
    const nextCamera = cameras[(activeIndex + 1) % cameras.length];
    switchingRef.current = true;
    setSwitching(true);
    setReady(false);

    try {
      isRunningRef.current = false;
      await scanner.stop();

      if (!mountedRef.current || scannerRef.current !== scanner) {
        scanner.clear();
        return;
      }

      await startCamera(scanner, nextCamera.id);

      if (!mountedRef.current || scannerRef.current !== scanner) {
        await scanner.stop();
        scanner.clear();
        return;
      }

      isRunningRef.current = true;
      activeCameraIdRef.current = nextCamera.id;
      setReady(true);
    } catch {
      if (mountedRef.current && scannerRef.current === scanner) {
        setError(
          tRef.current(
            "scanner.cameraError",
            "Could not access camera. Make sure no other app is using it.",
          ),
        );
      }
    } finally {
      switchingRef.current = false;
      if (mountedRef.current && scannerRef.current === scanner) {
        setSwitching(false);
      }
    }
  }

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
      <div
        className="relative w-full overflow-hidden rounded-xl"
        ref={containerRef}
      >
        {/* Camera feed — html5-qrcode renders into this div */}
        <div
          id={scannerId}
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
              <div
                className="absolute inset-0 rounded-2xl bg-black/40 ring-2 ring-white/20"
                style={{
                  boxShadow: "0 0 0 9999px rgba(0,0,0,0.4)",
                  background: "transparent",
                }}
              />

              {/* Corner markers */}
              <Corner position="top-left" />
              <Corner position="top-right" />
              <Corner position="bottom-left" />
              <Corner position="bottom-right" />
            </div>
          </div>
        )}

        {/* Close button */}
        {!hideClose && (
          <button
            type="button"
            onClick={onClose}
            className="absolute top-3 end-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        {cameraCount > 1 && (ready || switching) && (
          <button
            type="button"
            onClick={handleSwitchCamera}
            disabled={switching}
            aria-label={t("scanner.switchCamera", "Switch camera")}
            title={t("scanner.switchCamera", "Switch camera")}
            className="absolute bottom-3 end-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70 disabled:cursor-wait disabled:opacity-60"
          >
            <SwitchCamera className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Hint text */}
      <p className="text-xs text-muted-foreground text-center">
        {t("scanner.pointAtQR", "Point your camera at a QR code")}
      </p>
    </div>
  );
}

/** Corner bracket markers for the viewfinder */
function Corner({
  position,
}: {
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}) {
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
