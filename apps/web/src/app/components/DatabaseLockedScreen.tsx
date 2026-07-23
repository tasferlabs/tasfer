import { Button } from "@/components/ui/button";
import i18next from "i18next";

export function DatabaseLockedScreen({ error }: { error?: unknown }) {
  const locked = String(
    error instanceof Error ? error.message : (error ?? ""),
  ).includes("TASFER_DB_LOCKED");

  return (
    <div className="fixed inset-0 z-50 flex min-h-dvh w-screen flex-col items-center justify-center gap-4 overflow-hidden bg-background p-4 text-center text-foreground">
      <h1 className="text-2xl font-bold leading-tight">
        {i18next.t(
          locked
            ? "error.localDataLockedTitle"
            : "error.localDataUnavailableTitle",
          locked
            ? "Tasfer is open in another tab or window"
            : "We couldn't open your local data",
        )}
      </h1>
      <p className="max-w-[600px] text-base opacity-70">
        {locked
          ? i18next.t(
              "error.localDataLockedDesc",
              "Another Tasfer tab or window has the local data locked. Close it, then try again.",
            )
          : i18next.t(
              "error.localDataUnavailableDesc",
              "Tasfer couldn't access the data stored on this device. Try again, or restart your browser if the problem continues.",
            )}
      </p>
      <Button onClick={() => window.location.reload()}>
        {i18next.t("common.tryAgain", "Try again")}
      </Button>
    </div>
  );
}
