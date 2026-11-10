/**
 * How other `tasfer` commands reach a running host.
 *
 * The host listens on a small Unix socket in its data directory, `host.sock`.
 * A command connects, sends one line of JSON, reads one line back. Two
 * requests exist: `ping` (are you there, which build are you) and `restart`.
 *
 * A socket and not a pid file: a pid outlives its process. After a crash or a
 * reboot it can name some unrelated program, and signalling that kills
 * something nobody meant to touch. A socket only answers while the host that
 * opened it is alive.
 *
 * Restarting happens in place. The host stops the way Ctrl+C stops it, then
 * swaps itself for a fresh copy of its own executable with `execve` — same
 * process id, same terminal, same systemd unit — so after `tasfer update` the
 * new build is the one that comes back, and no supervisor has to notice.
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { isPackaged } from "./native";

const SOCKET_FILE = "host.sock";

/** Longer than this and the host is not answering, whatever it is doing. */
const REQUEST_TIMEOUT_MS = 3000;

/**
 * The longest socket path that binds everywhere we ship: macOS allows 104
 * bytes, Linux 108, both counting the terminating NUL. Past it the path is not
 * refused but cut short, and the socket appears somewhere else entirely.
 */
const MAX_SOCKET_PATH = 100;

/**
 * Where the host for this data directory listens. Inside the data directory
 * when the path is short enough, so it travels with it; otherwise a name
 * derived from that directory in this user's private runtime directory.
 */
export function controlSocketPath(dataDir: string): string {
  const resolved = path.resolve(dataDir);
  const inside = path.join(resolved, SOCKET_FILE);
  if (Buffer.byteLength(inside) <= MAX_SOCKET_PATH) return inside;

  const id = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(runtimeDir, `tasfer-${id}.sock`);
}

type Request = { cmd: "ping" } | { cmd: "restart" };

export interface Reply {
  ok: boolean;
  version: string;
  pid: number;
  /** Differs between two runs of the same process, which `execve` keeps. */
  instance: string;
  error?: "unsupported" | "unknown-command";
}

/** Whether this process can swap itself for a fresh copy of its executable. */
export function canRelaunch(): boolean {
  return typeof process.execve === "function";
}

/**
 * Replace this process with a fresh run of the same command. Does not return.
 *
 * A released build is a single executable whose arguments are all ours; a
 * source run is `node [node flags] dist/main.mjs` and needs the script and
 * Node's own flags carried over. `process.argv` repeats the executable at
 * index 1 in a released build, so the command's own words start at 2 in both.
 */
export function relaunch(): never {
  if (!process.execve) throw new Error("process.execve is not available");
  const words = process.argv.slice(2);
  const args = isPackaged()
    ? [process.argv0, ...words]
    : [process.argv0, ...process.execArgv, process.argv[1], ...words];
  return process.execve(process.execPath, args, process.env);
}

// =============================================================================
// Server — inside `tasfer host`
// =============================================================================

export interface ControlServer {
  /** Stop answering and remove the socket file. Safe to call twice. */
  close(): Promise<void>;
}

export interface ControlHandlers {
  version: string;
  instance: string;
  /** A restart was asked for and accepted. */
  onRestart(): void;
}

export type ListenResult =
  | { kind: "listening"; server: ControlServer }
  /** Another host already answers on this data directory. */
  | { kind: "taken"; pid: number }
  /** Could not open the socket; the host runs on without it. */
  | { kind: "unavailable"; reason: string };

export async function listenControl(
  dataDir: string,
  handlers: ControlHandlers,
): Promise<ListenResult> {
  const socketPath = controlSocketPath(dataDir);
  // The host opens its database after this, and a first run has no directory.
  mkdirSync(path.dirname(socketPath), { recursive: true });

  if (existsSync(socketPath)) {
    const other = await request(socketPath, { cmd: "ping" });
    if (other) return { kind: "taken", pid: other.pid };
    // Left by a host that died without cleaning up. Nobody answers on it.
    rmSync(socketPath, { force: true });
  }

  const reply = (extra: Partial<Reply> = {}): string =>
    JSON.stringify({
      ok: true,
      version: handlers.version,
      pid: process.pid,
      instance: handlers.instance,
      ...extra,
    } satisfies Reply) + "\n";

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => {});

    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      let cmd: unknown;
      try {
        cmd = (JSON.parse(buffer.slice(0, newline)) as { cmd?: unknown }).cmd;
      } catch {
        cmd = undefined;
      }

      if (cmd === "ping") {
        socket.end(reply());
      } else if (cmd === "restart") {
        if (!canRelaunch()) {
          socket.end(reply({ ok: false, error: "unsupported" }));
          return;
        }
        // Answer first, then go: the caller learns the request landed before
        // the socket it is reading from disappears.
        socket.end(reply(), () => handlers.onRestart());
      } else {
        socket.end(reply({ ok: false, error: "unknown-command" }));
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    return {
      kind: "unavailable",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
  // Whoever can connect can restart the host. That is the account running it.
  chmodSync(socketPath, 0o600);
  // A connection left open must not keep the process alive at shutdown.
  server.unref();

  let closed = false;
  return {
    kind: "listening",
    server: {
      async close() {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(socketPath, { force: true });
      },
    },
  };
}

// =============================================================================
// Client — `tasfer host restart`
// =============================================================================

/** Ask the host on this socket something. Null when no host answers there. */
export function request(
  socketPath: string,
  body: Request,
): Promise<Reply | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (value: Reply | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    const socket = net.connect(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("connect", () => socket.write(JSON.stringify(body) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(JSON.parse(buffer.slice(0, newline)) as Reply);
      } catch {
        finish(null);
      }
    });
    socket.on("end", () => finish(null));
  });
}
