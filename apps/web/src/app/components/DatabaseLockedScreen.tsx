import { Button } from "@/components/ui/button";
import { STALE_BUILD_ERROR } from "@/platform";
import i18next from "i18next";

/**
 * Shown when the local data can't be opened. Two causes: a tab still running a
 * previous build holds it (temporary — that tab going away is enough, and this
 * screen reloads itself when it does), or the browser's storage is genuinely
 * unreachable.
 */
export function DatabaseLockedScreen({ error }: { error?: unknown }) {
  const outdated = String(
    error instanceof Error ? error.message : (error ?? ""),
  ).includes(STALE_BUILD_ERROR);

  return (
    <div className="fixed inset-0 z-50 flex min-h-dvh w-screen flex-col items-center justify-center gap-4 overflow-hidden bg-background p-4 text-center text-foreground">
      <h1 className="text-2xl font-bold leading-tight">
        {i18next.t(
          outdated
            ? "error.appOutdatedTitle"
            : "error.localDataUnavailableTitle",
          outdated
            ? "Tasfer has been updated"
            : "We couldn't open your local data",
        )}
      </h1>
      <p className="max-w-[600px] text-base opacity-70">
        {outdated
          ? i18next.t(
              "error.appOutdatedDesc",
              "Another tab is still running the previous version and is using your local data. Close or reload it — this tab will continue on its own.",
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
