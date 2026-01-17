import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CLIENT_VERSION, BUILD_TIMESTAMP } from "@/version";
import { useVersion } from "../contexts/VersionContext";

export default function ForceUpdatePage() {
  const { t } = useTranslation();
  const { versionInfo, updateUrl, performUpdate } = useVersion();

  const minVersion = versionInfo?.minClientVersion ?? "unknown";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full text-center space-y-6">
        {/* Update icon */}
        <div className="mx-auto w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
          <svg
            className="w-10 h-10 text-primary"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
            />
          </svg>
        </div>

        {/* Title */}
        <h1 className="text-2xl font-semibold text-foreground">
          {t`Update Required`}
        </h1>

        {/* Description */}
        <p className="text-muted-foreground">
          {versionInfo?.updateMessage ||
            t`A new version of the app is required to continue. Please update to access the latest features and security improvements.`}
        </p>

        {/* Version info */}
        <div className="bg-muted/50 rounded-lg p-4 text-sm space-y-1">
          <div className="flex justify-between text-muted-foreground">
            <span>{t`Your version`}</span>
            <span className="font-mono">{CLIENT_VERSION}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{t`Required version`}</span>
            <span className="font-mono">{minVersion}</span>
          </div>
        </div>

        {/* Update button */}
        <Button onClick={performUpdate} size="lg" className="w-full">
          {updateUrl ? t`Update Now` : t`Reload`}
        </Button>

        {/* Build info for debugging */}
        <p className="text-xs text-muted-foreground/60">
          Build: {BUILD_TIMESTAMP}
        </p>
      </div>
    </div>
  );
}
