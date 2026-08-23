/**
 * Argument parsing.
 *
 * Hand-rolled rather than a dependency: the CLI has a dozen options, and a
 * self-hoster's install should be the host plus SQLite, not a parser tree.
 *
 * Accepts `--name value`, `--name=value` and bare `--flag`. Everything before
 * the first option is the command path.
 */

import { t, type MessageKey } from "./messages";

/** A message the user should see, with no stack trace attached. */
export class CliError extends Error {
  constructor(key: MessageKey, params?: Record<string, string | number>) {
    super(t(key, params));
    this.name = "CliError";
  }
}

export interface Args {
  /** Positional words, in order: `host link ABC` → ["host", "link", "ABC"]. */
  positionals: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    const [name, inlineValue] = splitOption(arg);
    if (inlineValue !== undefined) {
      flags.set(name, inlineValue);
      continue;
    }

    // A value is whatever follows, unless it is another `--option`. Every
    // option that takes a value is spelled `--name`, and the only bare flags
    // (`--help`, `--version`) are read with `.has()`, so swallowing a word
    // after one of those changes nothing.
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }

  return { positionals, flags };
}

function splitOption(arg: string): [string, string | undefined] {
  const body = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
  const eq = body.indexOf("=");
  if (eq === -1) return [body, undefined];
  return [body.slice(0, eq), body.slice(eq + 1)];
}

/** Reject anything the command does not know, so a typo is not silently lost. */
export function rejectUnknown(args: Args, allowed: readonly string[]): void {
  for (const name of args.flags.keys()) {
    if (!allowed.includes(name)) {
      throw new CliError("error.unknownOption", { option: `--${name}` });
    }
  }
}

export function stringFlag(
  args: Args,
  name: string,
  fallback: string,
): string;
export function stringFlag(
  args: Args,
  name: string,
  fallback?: undefined,
): string | undefined;
export function stringFlag(
  args: Args,
  name: string,
  fallback?: string,
): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  if (value === true) {
    throw new CliError("error.optionNeedsValue", { option: `--${name}` });
  }
  return value;
}

export function numberFlag(args: Args, name: string, fallback: number): number {
  const value = stringFlag(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliError("error.badNumber", { option: `--${name}`, value });
  }
  return parsed;
}

export function boolFlag(args: Args, name: string): boolean {
  const value = args.flags.get(name);
  return value === true || value === "true";
}
