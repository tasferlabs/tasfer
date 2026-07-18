import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { AlertCircle, AlertTriangle, Check, Copy, Github, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isDevToolsEnabled } from "@/lib/devTools";
import {
  FULLSCREEN_SAFE_AREA,
  FULLSCREEN_SAFE_AREA_PADDED,
  fullscreenChromeBarStyle,
  NO_DRAG,
} from "@/lib/fullscreenChrome";
import {
  buildDiagnostics,
  buildIssueUrl,
  useReportPath,
  type ErrorInfo,
} from "@/lib/reportIssue";

function normalizeError(error: unknown): ErrorInfo {
  if (isRouteErrorResponse(error)) {
    return {
      name: `${error.status} ${error.statusText}`,
      message:
        typeof error.data === "string"
          ? error.data
          : JSON.stringify(error.data ?? {}, null, 2),
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: "Error",
    message: typeof error === "string" ? error : JSON.stringify(error),
  };
}

function useIssueUrl(info: ErrorInfo, intro: string): string {
  const path = useReportPath();
  return buildIssueUrl(
    `[Bug] ${info.name}: ${info.message}`,
    `${intro}\n\n\n---\n\n${buildDiagnostics(info, path)}`,
  );
}

/** Copy-to-clipboard state + handler shared by both views. */
function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context / denied) — nothing to do.
    }
  };
  return { copied, copy };
}

/**
 * Developer view: the stack trace is the whole page. Styled to match the Tasfer
 * Inspector (DevToolbar) — dense monospace over a bordered chrome bar, so a
 * thrown error reads like the rest of the dev surface rather than a modal.
 */
function DevErrorView({ info }: { info: ErrorInfo }) {
  const { t } = useTranslation();
  const path = useReportPath();
  const issueUrl = useIssueUrl(
    info,
    t(
      "error.boundary.issueIntro",
      "Describe what you were doing when this happened:",
    ),
  );
  const { copied, copy } = useCopy(buildDiagnostics(info, path));

  const actionClass =
    "h-6 px-1.5 flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0";

  return (
    <div
      style={FULLSCREEN_SAFE_AREA}
      className="flex min-h-dvh w-full flex-col bg-background font-sans text-foreground"
    >
      {/* Chrome bar — draggable window region on desktop, inset past traffic lights */}
      <div
        style={fullscreenChromeBarStyle()}
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3"
      >
        <AlertCircle className="size-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 truncate font-mono text-[12px] font-medium text-destructive">
          {info.name}
        </span>
        <div className="flex-1" />
        <button type="button" onClick={copy} style={NO_DRAG} className={actionClass}>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied
            ? t("common.copied", "Copied")
            : t("error.boundary.copyDetails", "Copy details")}
        </button>
        <a
          href={issueUrl}
          target="_blank"
          rel="noreferrer noopener"
          style={NO_DRAG}
          className={actionClass}
        >
          <Github className="size-3" />
          {t("error.boundary.reportIssue", "Report issue")}
        </a>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={NO_DRAG}
          className={actionClass}
        >
          <RefreshCw className="size-3" />
          {t("error.boundary.reload", "Reload")}
        </button>
      </div>

      {/* Message */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <p className="font-mono text-[12px] break-words text-foreground">
          {info.message}
        </p>
      </div>

      {/* Stack trace — the primary content, fills the viewport */}
      <div dir="ltr" className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <pre className="font-mono text-[11px] leading-[1.6] whitespace-pre-wrap break-words text-muted-foreground">
          {info.stack || info.message}
        </pre>
      </div>

      {/* Environment footer */}
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 font-mono text-[10px] text-muted-foreground/70">
        <span>v{__CLIENT_VERSION__}</span>
        <span className="tabular-nums">{__BUILD_TIMESTAMP__}</span>
        <span className="min-w-0 truncate">{window.location.pathname}</span>
      </div>
    </div>
  );
}

/**
 * Reader view: a calm, non-technical screen. No stack, no "go home" — just
 * recover (reload) or help us fix it (report).
 */
function UserErrorView({ info }: { info: ErrorInfo }) {
  const { t } = useTranslation();
  const issueUrl = useIssueUrl(
    info,
    t(
      "error.boundary.issueIntro",
      "Describe what you were doing when this happened:",
    ),
  );

  return (
    <div
      style={FULLSCREEN_SAFE_AREA_PADDED}
      className="flex min-h-dvh w-full flex-col items-center justify-center gap-6 bg-background text-center text-foreground"
    >
      <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="size-7" />
      </div>

      <div className="flex max-w-md flex-col items-center gap-2">
        <h1 className="text-xl font-semibold">
          {t("error.boundary.title", "Something broke")}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t(
            "error.boundary.description",
            "The app hit an unexpected error and couldn't continue. You can reload the page, or report this so it gets fixed.",
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={() => window.location.reload()}>
          <RefreshCw />
          {t("error.boundary.reload", "Reload")}
        </Button>
        <Button variant="outline" asChild>
          <a href={issueUrl} target="_blank" rel="noreferrer noopener">
            <Github />
            {t("error.boundary.reportIssue", "Report issue")}
          </a>
        </Button>
      </div>
    </div>
  );
}

export function RouteErrorBoundary() {
  const error = useRouteError();
  const info = normalizeError(error);

  // Log to the console so the full stack is always retrievable, even in the
  // reader view where the trace is hidden.
  console.error("[RouteError]", error);

  // Show the developer stack view on the Vite dev server or whenever Tasfer
  // Inspector is switched on; otherwise show the calm reader screen.
  const showDev = import.meta.env.DEV || isDevToolsEnabled();

  return showDev ? <DevErrorView info={info} /> : <UserErrorView info={info} />;
}

export default RouteErrorBoundary;
