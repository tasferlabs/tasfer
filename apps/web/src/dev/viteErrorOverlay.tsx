/**
 * Vite HMR error overlay — devtools edition.
 *
 * Vite's built-in overlay is a shadow-DOM web component that can't be themed, so
 * we disable it (`server.hmr.overlay: false`) and render our own from the
 * `vite:error` HMR event instead. The result matches the Cypher Inspector
 * (DevToolbar / RouteErrorBoundary dev view): dense monospace chrome, the code
 * frame and stack front and center, plus Copy / Report actions.
 *
 * Dev-only: `initViteErrorOverlay` is reached exclusively behind an
 * `import.meta.hot` guard, so it is tree-shaken out of production builds.
 */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ErrorPayload } from "vite";
import { AlertCircle, Check, Copy, Github, RefreshCw, X } from "lucide-react";
import {
  FULLSCREEN_SAFE_AREA,
  fullscreenChromeBarStyle,
  NO_DRAG,
} from "@/lib/fullscreenChrome";

type ViteErr = ErrorPayload["err"];

const GITHUB_NEW_ISSUE_URL = "https://github.com/hamza512b/cypher/issues/new";

/** Location label, e.g. `src/app/foo.tsx:12:4`. */
function locLabel(err: ViteErr): string | null {
  const file = err.loc?.file || err.id;
  if (!file) return null;
  const rel = file.replace(/^.*?\/(src|packages|apps)\//, "$1/");
  return err.loc ? `${rel}:${err.loc.line}:${err.loc.column}` : rel;
}

function buildDiagnostics(err: ViteErr): string {
  const parts = [`**Build error${err.plugin ? ` (${err.plugin})` : ""}**`, ""];
  const loc = locLabel(err);
  if (loc) parts.push(`\`${loc}\``, "");
  parts.push("```", err.frame ? `${err.message}\n\n${err.frame}` : err.message, "```");
  if (err.stack) parts.push("", "```", err.stack, "```");
  return parts.join("\n");
}

function issueUrl(err: ViteErr): string {
  const title = `[Build] ${err.plugin ? `${err.plugin}: ` : ""}${err.message}`.slice(
    0,
    120,
  );
  const body = `Describe what you were doing when this happened:\n\n\n---\n\n${buildDiagnostics(
    err,
  )}`;
  return `${GITHUB_NEW_ISSUE_URL}?title=${encodeURIComponent(
    title,
  )}&body=${encodeURIComponent(body)}`;
}

/** Subscribe to Vite's HMR error / update events. */
function useViteError(): [ViteErr | null, () => void] {
  const [err, setErr] = useState<ViteErr | null>(null);
  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    const onError = (payload: ErrorPayload) => setErr(payload.err);
    const clear = () => setErr(null);
    hot.on("vite:error", onError);
    // A successful update means the error was resolved — drop the overlay.
    hot.on("vite:afterUpdate", clear);
    hot.on("vite:beforeUpdate", clear);
    return () => {
      hot.off("vite:error", onError);
      hot.off("vite:afterUpdate", clear);
      hot.off("vite:beforeUpdate", clear);
    };
  }, []);
  return [err, () => setErr(null)];
}

const actionClass =
  "h-6 px-1.5 flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0";

function ViteErrorOverlay() {
  const [err, dismiss] = useViteError();
  const [copied, setCopied] = useState(false);

  if (!err) return null;

  const loc = locLabel(err);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildDiagnostics(err));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — nothing to do.
    }
  };

  return (
    <div
      style={{ zIndex: 2147483000, ...FULLSCREEN_SAFE_AREA }}
      className="fixed inset-0 flex flex-col bg-background/98 font-sans text-foreground backdrop-blur-sm"
    >
      {/* Chrome bar — draggable window region on desktop, inset past traffic lights */}
      <div
        style={fullscreenChromeBarStyle()}
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3"
      >
        <AlertCircle className="size-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 truncate font-mono text-[12px] font-medium text-destructive">
          {err.plugin ? `Build error · ${err.plugin}` : "Build error"}
        </span>
        <div className="flex-1" />
        <button type="button" onClick={copy} style={NO_DRAG} className={actionClass}>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy details"}
        </button>
        <a
          href={issueUrl(err)}
          target="_blank"
          rel="noreferrer noopener"
          style={NO_DRAG}
          className={actionClass}
        >
          <Github className="size-3" />
          Report issue
        </a>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={NO_DRAG}
          className={actionClass}
        >
          <RefreshCw className="size-3" />
          Reload
        </button>
        <button
          type="button"
          onClick={dismiss}
          style={NO_DRAG}
          className={actionClass}
          aria-label="Dismiss"
        >
          <X className="size-3" />
        </button>
      </div>

      {/* Message + location */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <p className="font-mono text-[12px] break-words text-foreground">
          {err.message}
        </p>
        {loc && (
          <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">
            {loc}
          </p>
        )}
      </div>

      {/* Code frame + stack — the primary content */}
      <div dir="ltr" className="min-h-0 flex-1 overflow-auto">
        {err.frame && (
          <pre className="border-b border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-[1.6] whitespace-pre break-words text-foreground">
            {err.frame}
          </pre>
        )}
        {err.stack && (
          <pre className="px-3 py-2 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap break-words text-muted-foreground">
            {err.stack}
          </pre>
        )}
      </div>
    </div>
  );
}

let mounted = false;

/** Mount the overlay into its own React root, isolated from the app tree. */
export function initViteErrorOverlay() {
  if (mounted) return;
  mounted = true;
  const el = document.createElement("div");
  el.id = "vite-error-overlay-root";
  document.body.appendChild(el);
  createRoot(el).render(<ViteErrorOverlay />);
}
