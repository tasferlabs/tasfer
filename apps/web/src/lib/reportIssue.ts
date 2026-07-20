import { useMatches } from "react-router-dom";

export const GITHUB_NEW_ISSUE_URL =
  "https://github.com/hamza512b/tasfer/issues/new";

/** Build a GitHub "new issue" URL with a prefilled title and body. */
export function buildIssueUrl(title: string, body: string): string {
  return `${GITHUB_NEW_ISSUE_URL}?title=${encodeURIComponent(
    title.slice(0, 120),
  )}&body=${encodeURIComponent(body)}`;
}

/** Normalized view of whatever went wrong, used to build a report body. */
export interface ErrorInfo {
  /** Short headline, e.g. "TypeError" or "404 Not Found". */
  name: string;
  /** Human-readable message. */
  message: string;
  /** Full stack trace when the thrown value carried one. */
  stack?: string;
}

/**
 * The current route path with dynamic segments replaced by their param name,
 * e.g. `/page/:id` rather than `/page/6f3c…`. Keeps page ids (and any other
 * route params) out of filed reports, and works under the desktop hash router
 * where `window.location` doesn't reflect the app path.
 */
export function useReportPath(): string {
  const matches = useMatches();
  const last = matches[matches.length - 1];
  if (!last) return window.location.pathname;
  const paramNames = new Map(
    Object.entries(last.params)
      .filter(([, value]) => value)
      .map(([key, value]) => [value, key]),
  );
  return last.pathname
    .split("/")
    .map((segment) =>
      paramNames.has(segment) ? `:${paramNames.get(segment)}` : segment,
    )
    .join("/");
}

/** Environment context table shared by every issue report. */
export function buildEnvTable(path: string): string {
  return [
    "| | |",
    "| --- | --- |",
    `| Version | ${__CLIENT_VERSION__} |`,
    `| Build | ${__BUILD_TIMESTAMP__} |`,
    `| Commit | ${__BUILD_COMMIT__} |`,
    `| Path | ${path} |`,
    `| User agent | ${navigator.userAgent} |`,
  ].join("\n");
}

/**
 * Build the plaintext diagnostics block used for the "Copy" action and the
 * prefilled GitHub issue body. Keeps environment context (version, build,
 * path) next to the stack trace so a filed report is actionable.
 */
export function buildDiagnostics(info: ErrorInfo, path: string): string {
  return [
    `**${info.name}**`,
    "",
    "```",
    info.stack || info.message,
    "```",
    "",
    buildEnvTable(path),
  ].join("\n");
}
