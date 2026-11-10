/**
 * Remote dev console: lets you debug the app on another device (a phone, a
 * tablet, another browser) from the terminal, without remote devtools. Pairs
 * with `scripts/remote-dev-console-plugin.ts`.
 *
 * Forwards to the dev server, which prints to the terminal and appends to
 * `remote-dev-console.log`:
 * - every `console.*` call,
 * - uncaught errors and unhandled promise rejections,
 *
 * Vite dev only
 */

const ROUTE = "/__remote-dev-console";
const LEVELS = ["log", "info", "warn", "error", "debug"] as const;

type Entry = {
  session: string;
  seq: number;
  t: number;
  level: string;
  text: string;
};

function enabled(): boolean {
  return (
    import.meta.env.DEV && import.meta.env.VITE_REMOTE_DEV_CONSOLE !== "false"
  );
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error)
    return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "function") return `[function ${value.name}]`;
  if (value instanceof Node) return `<${value.nodeName.toLowerCase()}>`;
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return String(value);
  }
}

export function installRemoteDevConsole(): void {
  if (!enabled()) return;

  const session = Math.random().toString(36).slice(2, 6);
  let seq = 0;
  let queue: Entry[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    if (queue.length === 0) return;
    const body = JSON.stringify(queue);
    queue = [];
    fetch(ROUTE, { method: "POST", body, keepalive: true }).catch(() => {});
  };

  const push = (level: string, text: string) => {
    queue.push({ session, seq: seq++, t: performance.now(), level, text });
    timer ??= setTimeout(flush, 200);
  };

  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        push(level, args.map(stringify).join(" "));
      } catch {
        // Never let logging break the page.
      }
    };
  }

  window.addEventListener("error", (e) =>
    push("error", `uncaught: ${stringify(e.error ?? e.message)}`),
  );
  window.addEventListener("unhandledrejection", (e) =>
    push("error", `unhandled rejection: ${stringify(e.reason)}`),
  );
  window.addEventListener("pagehide", flush);

  push("info", `session start ${navigator.userAgent} ${location.href}`);
}
