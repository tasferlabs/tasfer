import { useMatches } from "react-router-dom";
import type { ErrorLogEntry } from "./errorLog";

export const GITHUB_NEW_ISSUE_URL =
  "https://github.com/tasferlabs/tasfer/issues/new";

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
  return redactRouteParams(last.pathname, last.params);
}

/** `pathname` with every segment that is a route param swapped for its name. */
export function redactRouteParams(
  pathname: string,
  params: Record<string, string | undefined>,
): string {
  const paramNames = new Map(
    Object.entries(params)
      .filter(([, value]) => value)
      .map(([key, value]) => [value, key]),
  );
  return pathname
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
    `| Version | ${__APP_VERSION__} |`,
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

/**
 * Stack text kept in a filed error-log entry. GitHub rejects new-issue URLs
 * past roughly 8 KB, and percent-encoding a stack can triple its length.
 */
const ISSUE_STACK_CHARS = 1500;
const ISSUE_MESSAGE_CHARS = 500;

function clipForIssue(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/**
 * The details of one Settings → Error log entry, as Markdown: the stack and the
 * environment the error happened in — its version, commit and route — not the
 * build the person is looking at it from. Pass `clip` to shorten long text for
 * a URL; the copied version keeps all of it.
 */
export function buildErrorLogDiagnostics(
  entry: ErrorLogEntry,
  clip = false,
): string {
  const message = clip
    ? clipForIssue(entry.message, ISSUE_MESSAGE_CHARS)
    : entry.message;
  const trace = entry.stack || message;
  return [
    `**${entry.name}**`,
    "",
    "```",
    clip ? clipForIssue(trace, ISSUE_STACK_CHARS) : trace,
    "```",
    "",
    "| | |",
    "| --- | --- |",
    `| Version | ${entry.version} |`,
    `| Commit | ${entry.commit} |`,
    `| Path | ${entry.path} |`,
    `| Source | ${entry.source} |`,
    `| Occurrences | ${entry.count} |`,
    `| First seen | ${new Date(entry.firstSeen).toISOString()} |`,
    `| Last seen | ${new Date(entry.lastSeen).toISOString()} |`,
    `| User agent | ${navigator.userAgent} |`,
  ].join("\n");
}

/** Prefilled GitHub issue for one Settings → Error log entry. */
export function buildErrorLogIssueUrl(
  entry: ErrorLogEntry,
  intro: string,
): string {
  return buildIssueUrl(
    `[Bug] ${entry.name}: ${entry.message}`,
    `${intro}\n\n\n---\n\n${buildErrorLogDiagnostics(entry, true)}`,
  );
}
