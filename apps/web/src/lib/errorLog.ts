/**
 * The error log shown in Settings → Error log: every `console.error`, uncaught
 * error and unhandled promise rejection in this window, kept on this device so
 * a person can look back at what went wrong and file it as an issue.
 *
 * It lives in `localStorage`, never in the document store: it is about this
 * machine and must not sync to the person's other devices or to a space.
 * Repeats of one error fold into a single entry with a count, entries are
 * dropped 30 days after they last happened, and the list is capped, so an error in
 * a loop cannot fill the storage quota.
 *
 * Every tab of the app shares the one stored list. Each write re-reads what is
 * stored and adds only this tab's new occurrences, so tabs don't overwrite each
 * other, and the `storage` event keeps every open Settings view current.
 *
 * Host-wide on purpose, like `devToolsFlag.ts`: `console` and `window` belong
 * to the page, not to an editor, so there is one log per window. React-free so
 * it can start before the app renders and catch a failed startup.
 */

const LOG_KEY = "tasfer:error-log";
const GLOBAL_HOOK = "__tasferErrorLog";

/** How long an entry is kept after it last happened, in days. */
export const ERROR_LOG_RETENTION_DAYS = 30;

const MAX_ENTRIES = 50;
const MAX_MESSAGE = 2000;
const MAX_STACK = 4000;
const FLUSH_DELAY_MS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ErrorLogSource = "console" | "uncaught" | "rejection";

export interface ErrorLogEntry {
  /** Stable across tabs: a hash of what makes two errors "the same". */
  id: string;
  source: ErrorLogSource;
  /** Short headline, e.g. "TypeError". */
  name: string;
  message: string;
  stack?: string;
  /** Route pattern at the time, with ids swapped for param names. */
  path: string;
  version: string;
  commit: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
}

/** One error as it happened, before it is folded into the stored list. */
export interface ErrorOccurrence {
  source: ErrorLogSource;
  name: string;
  message: string;
  stack?: string;
  path: string;
  version: string;
  commit: string;
  time: number;
  /** What two occurrences must share to count as the same error. */
  fingerprint: string;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 32-bit FNV-1a, hex. Only an identity for folding repeats, not security. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value === undefined) return "undefined";
  if (typeof value === "function") return `[function ${value.name}]`;
  try {
    return clip(JSON.stringify(value) ?? String(value), MAX_MESSAGE);
  } catch {
    return String(value);
  }
}

/**
 * Join `console.error` arguments the way the console prints them, including
 * `%s`/`%o`-style substitution in a leading format string. `%c` styling is
 * dropped along with its argument.
 */
export function formatConsoleArgs(args: readonly unknown[]): string {
  const rest = [...args];
  const parts: string[] = [];
  if (typeof rest[0] === "string" && /%[sdifoOc]/.test(rest[0])) {
    const format = rest.shift() as string;
    parts.push(
      format.replace(/%([sdifoOc%])/g, (match, spec: string) => {
        if (spec === "%") return "%";
        if (rest.length === 0) return match;
        const value = rest.shift();
        return spec === "c" ? "" : formatValue(value);
      }),
    );
  }
  for (const value of rest) parts.push(formatValue(value));
  return parts.join(" ");
}

function errorName(error: Error): string {
  return error.name || "Error";
}

/**
 * What makes two reports the same error: its name and message, with numbers
 * and ids masked so "page 0CHHuesvE2 not found" matches across pages. The stack is
 * left out on purpose — a new build renames and moves every frame, and the
 * same bug must not become a fresh entry with each release.
 */
function fingerprintOf(name: string, message: string): string {
  // Any id-like token — six or more word characters with a digit among them,
  // hex or not ("3f9a2c1e-77b0", "0CHHuesvE2") — then any number left over.
  const masked = message
    .replace(/\b(?=[\w-]*\d)[\w-]{6,}\b/g, "#")
    .replace(/\d+/g, "#");
  return `${name}\n${masked}`;
}

/**
 * Turn whatever was reported into one occurrence. When an `Error` is among the
 * values, its own name and message identify it, so the same thrown error
 * reported twice — once by an error boundary's `console.error` with a prefix,
 * once as uncaught — folds into one entry.
 */
export function describeOccurrence(
  source: ErrorLogSource,
  values: readonly unknown[],
  context: { path: string; version: string; commit: string; time: number },
): ErrorOccurrence {
  const error = values.find((v): v is Error => v instanceof Error);
  const message = clip(
    source === "console"
      ? formatConsoleArgs(values)
      : values.map(formatValue).join(" "),
    MAX_MESSAGE,
  );
  const stack = error?.stack ? clip(error.stack, MAX_STACK) : undefined;
  const name = error ? errorName(error) : "Error";
  return {
    source,
    name,
    message: message || name,
    stack,
    ...context,
    fingerprint: fingerprintOf(name, error ? error.message : message),
  };
}

/** Drop entries last seen before the retention window, newest first, capped. */
export function pruneEntries(
  entries: readonly ErrorLogEntry[],
  now: number,
): ErrorLogEntry[] {
  const cutoff = now - ERROR_LOG_RETENTION_DAYS * DAY_MS;
  return entries
    .filter((entry) => entry.lastSeen >= cutoff)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, MAX_ENTRIES);
}

/**
 * Fold new occurrences into the stored entries, then prune. A repeat takes the
 * latest occurrence's details — message, stack, build, route — so a report
 * filed from it describes the newest build it happened in.
 */
export function mergeOccurrences(
  entries: readonly ErrorLogEntry[],
  occurrences: readonly ErrorOccurrence[],
  now: number,
): ErrorLogEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, { ...entry }]));
  for (const occurrence of occurrences) {
    const id = hash(occurrence.fingerprint);
    const { fingerprint: _fingerprint, time, ...details } = occurrence;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        ...details,
        id,
        firstSeen: time,
        lastSeen: time,
        count: 1,
      });
      continue;
    }
    existing.count += 1;
    existing.firstSeen = Math.min(existing.firstSeen, time);
    if (time >= existing.lastSeen) {
      Object.assign(existing, details, { lastSeen: time });
    }
  }
  return pruneEntries([...byId.values()], now);
}

function isEntry(value: unknown): value is ErrorLogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ErrorLogEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.message === "string" &&
    typeof entry.lastSeen === "number" &&
    typeof entry.firstSeen === "number" &&
    typeof entry.count === "number"
  );
}

/** Stored text → entries. A malformed list reads as empty, not as a crash. */
export function parseEntries(raw: string | null): ErrorLogEntry[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isEntry) : [];
  } catch {
    return [];
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

function readStoredEntries(): ErrorLogEntry[] | undefined {
  try {
    return parseEntries(localStorage.getItem(LOG_KEY));
  } catch {
    // localStorage unavailable (private mode) — the log lives in memory only.
    return undefined;
  }
}

function writeStoredEntries(entries: ErrorLogEntry[]): void {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(entries));
  } catch {
    // Over quota: keep the newer half rather than nothing.
    try {
      localStorage.setItem(
        LOG_KEY,
        JSON.stringify(entries.slice(0, Math.floor(entries.length / 2))),
      );
    } catch {
      // Still no room — the in-memory list keeps this session's errors.
    }
  }
}

// ── Live store ───────────────────────────────────────────────────────────────

let entries: ErrorLogEntry[] = [];
let pending: ErrorOccurrence[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let getPath: () => string = () => "/";
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function flush(): void {
  flushTimer = undefined;
  const occurrences = pending;
  pending = [];
  const stored = readStoredEntries();
  entries = mergeOccurrences(stored ?? entries, occurrences, Date.now());
  writeStoredEntries(entries);
  emit();
}

function scheduleFlush(): void {
  if (flushTimer === undefined) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

/** Re-read what another tab (or a prune on load) left in storage. */
function reload(): void {
  const stored = readStoredEntries();
  if (stored) entries = pruneEntries(stored, Date.now());
  emit();
}

function buildConstant(read: () => string): string {
  try {
    return read();
  } catch {
    // Not defined outside a Vite build (unit tests).
    return "unknown";
  }
}

function record(source: ErrorLogSource, values: readonly unknown[]): void {
  let path = "/";
  try {
    path = getPath();
  } catch {
    // The router may not exist yet during startup.
  }
  pending.push(
    describeOccurrence(source, values, {
      path,
      version: buildConstant(() => __APP_VERSION__),
      commit: buildConstant(() => __BUILD_COMMIT__),
      time: Date.now(),
    }),
  );
  scheduleFlush();
}

/** The current entries, newest first. Stable between changes. */
export function getErrorLog(): ErrorLogEntry[] {
  return entries;
}

export function subscribeErrorLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forget every entry, in every tab. */
export function clearErrorLog(): void {
  pending = [];
  entries = [];
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {
    // Nothing stored to remove.
  }
  emit();
}

/** What the once-only patches call into; each hot reload repoints it. */
interface ErrorLogHooks {
  record: (source: ErrorLogSource, values: readonly unknown[]) => void;
  reload: () => void;
  flushNow: () => void;
}

/**
 * Start recording. Call once at startup, before anything that can fail.
 * `routePath` names where the person was, with ids already redacted.
 *
 * Safe across hot reloads: `console` and `window` are patched once, and they
 * call through hooks that each reload points at the current module.
 */
export function installErrorLog(
  options: { routePath?: () => string } = {},
): void {
  if (typeof window === "undefined") return;
  if (options.routePath) getPath = options.routePath;
  const scope = globalThis as unknown as { [GLOBAL_HOOK]?: ErrorLogHooks };
  const alreadyPatched = scope[GLOBAL_HOOK] !== undefined;
  scope[GLOBAL_HOOK] = {
    record,
    reload,
    flushNow: () => {
      if (flushTimer === undefined) return;
      clearTimeout(flushTimer);
      flush();
    },
  };

  // Drop what an earlier session left behind past the 30 days.
  reload();
  writeStoredEntries(entries);

  if (alreadyPatched) return;
  const hooks = () => scope[GLOBAL_HOOK];

  // A failure while recording must never take the page down with it, nor
  // recurse back into the log.
  let recording = false;
  const safely = (source: ErrorLogSource, values: readonly unknown[]) => {
    if (recording) return;
    recording = true;
    try {
      hooks()?.record(source, values);
    } catch {
      // Dropped: the log is a diagnostic, not part of the app's behaviour.
    } finally {
      recording = false;
    }
  };

  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    safely("console", args);
  };
  window.addEventListener("error", (event) => {
    safely("uncaught", [event.error ?? event.message]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    safely("rejection", [event.reason]);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === LOG_KEY) hooks()?.reload();
  });
  // Don't lose errors from the last half second before the tab goes away.
  window.addEventListener("pagehide", () => hooks()?.flushNow());
}
