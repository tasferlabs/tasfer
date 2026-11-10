/**
 * What each command is called, what it takes, and how its help reads.
 *
 * One table drives both the help text and which options a command accepts, so
 * the two cannot drift: an option a command's help does not list is one it
 * rejects.
 */

import os from "node:os";
import { t, type MessageKey } from "./messages";

/** Accepted everywhere, and read before any command runs. */
export const GLOBAL_OPTIONS = ["help", "h", "version", "v"] as const;

export type OptionName =
  | "data-dir"
  | "signal-url"
  | "transport"
  | "auto-update"
  | "name"
  | "ttl"
  | "out"
  | "space"
  | "check";

interface OptionSpec {
  /** What follows the flag, `<path>`; none for an on/off flag. */
  value?: string;
  desc: MessageKey;
  /** What the command uses when the option is left out, worked out now. */
  fallback?: (env: HelpEnv) => string;
}

/** What a default depends on, handed in so this table holds no state. */
export interface HelpEnv {
  dataDir: string;
  signalUrl: string;
  inviteTtlMinutes: number;
}

const OPTIONS: Record<OptionName, OptionSpec> = {
  "data-dir": {
    value: "<path>",
    desc: "usage.optDataDir",
    fallback: (env) => env.dataDir,
  },
  "signal-url": {
    value: "<url>",
    desc: "usage.optSignalUrl",
    fallback: (env) => env.signalUrl,
  },
  transport: {
    value: "<mode>",
    desc: "usage.optTransport",
    fallback: () => "auto",
  },
  "auto-update": { desc: "usage.optAutoUpdate" },
  name: {
    value: "<label>",
    desc: "usage.optName",
    // The label `host link` writes when none is given.
    fallback: () => `${os.hostname()} (host)`,
  },
  ttl: {
    value: "<minutes>",
    desc: "usage.optTtl",
    fallback: (env) => String(env.inviteTtlMinutes),
  },
  out: {
    value: "<file>",
    desc: "usage.optOut",
    fallback: () => "tasfer-export-<date>.zip",
  },
  space: { value: "<name>", desc: "usage.optSpace" },
  check: { desc: "usage.optCheck" },
};

export type CommandId =
  | "host"
  | "host link"
  | "host invite"
  | "host status"
  | "host restart"
  | "export"
  | "update";

export interface CommandSpec {
  id: CommandId;
  /** How it is typed, arguments included: `host link <code>`. */
  usage: string;
  summary: MessageKey;
  options: readonly OptionName[];
}

const CONNECT: readonly OptionName[] = ["data-dir", "signal-url", "transport"];

/** In the order help lists them. */
export const COMMANDS: readonly CommandSpec[] = [
  { id: "host", usage: "host", summary: "usage.host", options: [...CONNECT, "auto-update"] },
  { id: "host link", usage: "host link <code>", summary: "usage.hostLink", options: [...CONNECT, "name"] },
  { id: "host invite", usage: "host invite", summary: "usage.hostInvite", options: [...CONNECT, "ttl"] },
  { id: "host status", usage: "host status", summary: "usage.hostStatus", options: ["data-dir"] },
  { id: "host restart", usage: "host restart", summary: "usage.hostRestart", options: ["data-dir"] },
  { id: "export", usage: "export [file]", summary: "usage.export", options: ["data-dir", "out", "space"] },
  { id: "update", usage: "update", summary: "usage.update", options: ["check"] },
];

const HOST_SUBCOMMANDS = ["link", "invite", "status", "restart"] as const;

export type Resolved =
  | { kind: "command"; spec: CommandSpec; rest: string[] }
  /** Words that name no command; `typed` is how to quote them back. */
  | { kind: "unknown"; typed: string };

/** Which command the leading words name, and what is left after them. */
export function resolveCommand(positionals: string[]): Resolved {
  const [first, second, ...rest] = positionals;
  const spec = (id: CommandId) => COMMANDS.find((c) => c.id === id)!;

  if (first === "host") {
    // `host run` is the long spelling of `host`.
    if (second === undefined || second === "run") {
      return { kind: "command", spec: spec("host"), rest };
    }
    if ((HOST_SUBCOMMANDS as readonly string[]).includes(second)) {
      return { kind: "command", spec: spec(`host ${second}` as CommandId), rest };
    }
    return { kind: "unknown", typed: `host ${second}` };
  }
  if (first === "export" || first === "update") {
    return {
      kind: "command",
      spec: spec(first),
      rest: second === undefined ? rest : [second, ...rest],
    };
  }
  return { kind: "unknown", typed: first };
}

/** Every option name the command accepts, short spellings included. */
export function acceptedOptions(spec: CommandSpec): string[] {
  return [...GLOBAL_OPTIONS, ...spec.options];
}

// =============================================================================
// Printing
// =============================================================================

const COLUMN = 24;

function row(left: string, right: string): string {
  // A left side too wide for the column gets its own line.
  return left.length < COLUMN - 2
    ? `  ${left.padEnd(COLUMN - 2)}${right}`
    : `  ${left}\n  ${" ".repeat(COLUMN - 2)}${right}`;
}

function optionRow(name: OptionName, env: HelpEnv): string {
  const option = OPTIONS[name];
  const flag = option.value ? `--${name} ${option.value}` : `--${name}`;
  const fallback = option.fallback?.(env);
  const desc = fallback
    ? `${t(option.desc)} ${t("usage.default", { value: fallback })}`
    : t(option.desc);
  return row(flag, desc);
}

/** `tasfer --help`: what the commands are, and how to ask about one. */
export function printOverview(): void {
  console.log(t("usage.summary"));
  console.log("");
  console.log(`${t("usage.usage")}: tasfer <command> [options]`);
  console.log("");
  console.log(`${t("usage.commands")}:`);
  for (const command of COMMANDS) {
    console.log(row(command.usage, t(command.summary)));
  }
  console.log("");
  console.log(`${t("usage.options")}:`);
  console.log(row("--help, -h", t("usage.optHelp")));
  console.log(row("--version, -v", t("usage.optVersion")));
  console.log("");
  console.log(t("usage.commandHelp"));
  console.log(t("usage.more"));
}

/** `tasfer <command> --help`: that command and only the options it takes. */
export function printCommandHelp(spec: CommandSpec, env: HelpEnv): void {
  console.log(t(spec.summary));
  console.log("");
  const suffix = spec.options.length > 0 ? " [options]" : "";
  console.log(`${t("usage.usage")}: tasfer ${spec.usage}${suffix}`);
  console.log("");
  console.log(`${t("usage.options")}:`);
  for (const name of spec.options) console.log(optionRow(name, env));
  console.log(row("--help, -h", t("usage.optHelp")));

  // `host` alone runs the host, so its help is also where the rest of the
  // `host` family is found.
  if (spec.id === "host") {
    console.log("");
    console.log(`${t("usage.hostFamily")}:`);
    for (const command of COMMANDS) {
      if (command.id.startsWith("host ")) {
        console.log(row(command.usage, t(command.summary)));
      }
    }
  }
  console.log("");
  console.log(t("usage.more"));
}
