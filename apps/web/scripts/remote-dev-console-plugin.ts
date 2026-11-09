/**
 * Remote dev console, server side: receives the console of the app running on
 * another device (pairs with `src/dev/remoteDevConsole.ts`), so you can debug
 * it from this terminal without remote devtools. The page POSTs batches to
 * `/__remote-dev-console` on the same origin, so it rides the LAN HTTPS cert with
 * no CORS or mixed-content trouble. Each line is printed to this terminal and
 * appended to `apps/web/remote-dev-console.log` (gitignored). `vite dev` only:
 * the plugin does not exist in builds.
 */

import { appendFileSync } from "fs";
import { resolve } from "path";
import type { Plugin } from "vite";

type Entry = {
  session: string;
  seq: number;
  /** ms since page load (performance.now). */
  t: number;
  level: string;
  text: string;
};

const ROUTE = "/__remote-dev-console";

// The route is open to anyone on the LAN, so a body is untrusted: capped in
// size, checked entry by entry, and stripped of control characters before it
// reaches the terminal (no injected ANSI escapes).
const MAX_BODY_BYTES = 1024 * 1024;

const COLORS: Record<string, string> = {
  error: "\x1b[31m",
  warn: "\x1b[33m",
  info: "\x1b[36m",
  debug: "\x1b[90m",
  event: "\x1b[35m",
};

// C0/C1 controls except tab and newline (ESC, CSI, BEL, CR...).
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function clean(value: unknown): string {
  return String(value).replace(CONTROL_CHARS, "");
}

function parseEntries(body: string): Entry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((raw): Entry[] => {
    if (!raw || typeof raw !== "object") return [];
    const e = raw as Record<string, unknown>;
    if (typeof e.text !== "string" || typeof e.level !== "string") return [];
    return [
      {
        session: clean(e.session ?? "?"),
        seq: typeof e.seq === "number" ? e.seq : 0,
        t: typeof e.t === "number" && Number.isFinite(e.t) ? e.t : 0,
        level: clean(e.level).toLowerCase(),
        text: clean(e.text),
      },
    ];
  });
}

export function remoteDevConsolePlugin(): Plugin {
  return {
    name: "tasfer:remote-dev-console",
    apply: "serve",
    configureServer(server) {
      const logFile = resolve(server.config.root, "remote-dev-console.log");
      server.config.logger.info(
        `\n  [remote-dev-console] device logs → this terminal and ${logFile}\n`,
      );
      server.middlewares.use(ROUTE, (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        let tooLarge = false;
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          if (tooLarge) return;
          body += chunk;
          if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
            tooLarge = true;
            body = "";
            res.statusCode = 413;
            res.end();
          }
        });
        req.on("error", () => {});
        req.on("end", () => {
          if (tooLarge) return;
          res.statusCode = 204;
          res.end();
          // Never let one bad batch throw out of this listener: an uncaught
          // exception here takes the whole dev server down.
          try {
            const lines: string[] = [];
            for (const e of parseEntries(body)) {
              const head = `[${e.session} #${e.seq} ${e.t.toFixed(1)}ms] ${e.level.toUpperCase()}`;
              lines.push(`${head} ${e.text}`);
              const color = COLORS[e.level] ?? "";
              process.stdout.write(`${color}${head}\x1b[0m ${e.text}\n`);
            }
            if (lines.length) appendFileSync(logFile, lines.join("\n") + "\n");
          } catch (error) {
            server.config.logger.warn(
              `[remote-dev-console] dropped a batch: ${String(error)}`,
            );
          }
        });
      });
    },
  };
}
