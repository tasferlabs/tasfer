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

const COLORS: Record<string, string> = {
  error: "\x1b[31m",
  warn: "\x1b[33m",
  info: "\x1b[36m",
  debug: "\x1b[90m",
  event: "\x1b[35m",
};

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
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => (body += chunk));
        req.on("end", () => {
          res.statusCode = 204;
          res.end();
          let entries: Entry[];
          try {
            entries = JSON.parse(body) as Entry[];
          } catch {
            return;
          }
          const lines: string[] = [];
          for (const e of entries) {
            const head = `[${e.session} #${e.seq} ${e.t.toFixed(1)}ms] ${e.level.toUpperCase()}`;
            lines.push(`${head} ${e.text}`);
            const color = COLORS[e.level] ?? "";
            process.stdout.write(`${color}${head}\x1b[0m ${e.text}\n`);
          }
          appendFileSync(logFile, lines.join("\n") + "\n");
        });
      });
    },
  };
}
