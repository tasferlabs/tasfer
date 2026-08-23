/**
 * `tasfer` — the self-hosting CLI.
 *
 * Two things a person can run on their own machine:
 *
 *   tasfer host    a headless replica that holds their spaces and stays online
 *   tasfer relay   the signaling relay their devices find each other through
 *
 * Neither needs the other, and neither needs us: a host works against the
 * public relay, a relay works for people running only the app.
 */

import {
  CliError,
  numberFlag,
  parseArgs,
  rejectUnknown,
  stringFlag,
  type Args,
} from "./cli/args";
import { setLanguage, t } from "./cli/messages";
import {
  DEFAULT_INVITE_TTL_MINUTES,
  inviteHost,
  linkHost,
  runHost,
  statusHost,
} from "./host/commands";
import {
  DEFAULT_SIGNAL_URL,
  defaultDataDir,
  type HostOptions,
} from "./host/runtime";
import type { Transport } from "./host/network";
import { runRelay, type RelayOptions } from "./relay/server";

const VERSION = "0.1.0";

const GLOBAL_FLAGS = ["help", "h", "version", "v", "lang"] as const;
const HOST_FLAGS = [
  ...GLOBAL_FLAGS,
  "data-dir",
  "signal-url",
  "transport",
  "name",
  "ttl",
] as const;
const RELAY_FLAGS = [
  ...GLOBAL_FLAGS,
  "port",
  "host",
  "turn-url",
  "turn-secret",
  "turn-ttl",
] as const;

const DEFAULT_RELAY_PORT = 8787;
const DEFAULT_RELAY_HOST = "127.0.0.1";
/** Matches the Cloudflare deployment's credential lifetime. */
const DEFAULT_TURN_TTL_SECONDS = 3600;

function hostOptions(args: Args): HostOptions {
  const transport = stringFlag(args, "transport", "auto");
  if (transport !== "auto" && transport !== "direct" && transport !== "relay") {
    throw new CliError("error.unknownOption", {
      option: `--transport ${transport}`,
    });
  }
  return {
    dataDir: stringFlag(args, "data-dir") ?? defaultDataDir(),
    signalUrl:
      stringFlag(args, "signal-url") ??
      process.env.TASFER_SIGNAL_URL ??
      DEFAULT_SIGNAL_URL,
    transport: transport as Transport,
  };
}

function relayOptions(args: Args): RelayOptions {
  const turnUrl = stringFlag(args, "turn-url");
  const turnSecret = stringFlag(args, "turn-secret") ?? process.env.TURN_SECRET;
  if (turnUrl && !turnSecret) throw new CliError("relay.turnSecretMissing");

  return {
    port: numberFlag(args, "port", Number(process.env.PORT) || DEFAULT_RELAY_PORT),
    host: stringFlag(args, "host", DEFAULT_RELAY_HOST),
    turnUrl,
    turnSecret,
    turnTtlSeconds: numberFlag(args, "turn-ttl", DEFAULT_TURN_TTL_SECONDS),
    // Cloudflare Calls stays available for anyone who already has a key —
    // the same two secrets the Worker deployment uses, read from the
    // environment rather than flags because they are credentials.
    cloudflareKeyId: process.env.TURN_KEY_ID,
    cloudflareApiToken: process.env.TURN_API_TOKEN,
  };
}

function printHelp(): void {
  const line = (left: string, right: string) =>
    `  ${left.padEnd(28)}${right}`;

  console.log(t("usage.summary"));
  console.log("");
  console.log(`${t("usage.commands")}:`);
  console.log(line("host", t("usage.host")));
  console.log(line("host link <code>", t("usage.hostLink")));
  console.log(line("host invite", t("usage.hostInvite")));
  console.log(line("host status", t("usage.hostStatus")));
  console.log(line("relay", t("usage.relay")));
  console.log("");
  console.log(`${t("usage.options")} (host):`);
  console.log(line("--data-dir <path>", t("usage.optDataDir")));
  console.log(line("--signal-url <url>", t("usage.optSignalUrl")));
  console.log(line("--transport <mode>", t("usage.optTransport")));
  console.log(line("--name <label>", t("usage.optName")));
  console.log(line("--ttl <minutes>", t("usage.optTtl")));
  console.log("");
  console.log(`${t("usage.options")} (relay):`);
  console.log(line("--port <number>", t("usage.optPort")));
  console.log(line("--host <address>", t("usage.optHost")));
  console.log(line("--turn-url <url>", t("usage.optTurnUrl")));
  console.log(line("--turn-secret <secret>", t("usage.optTurnSecret")));
  console.log(line("--turn-ttl <seconds>", t("usage.optTurnTtl")));
  console.log("");
  console.log(`${t("usage.options")}:`);
  console.log(line("--lang <en|ar>", t("usage.optLang")));
  console.log(line("--help, -h", t("usage.optHelp")));
  console.log(line("--version, -v", t("usage.optVersion")));
  console.log("");
  console.log(t("usage.more"));
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  setLanguage(stringFlag(args, "lang"));

  const wantsHelp = args.flags.has("help") || args.flags.has("h");
  const [command, subcommand, ...rest] = args.positionals;

  if (args.flags.has("version") || args.flags.has("v")) {
    console.log(VERSION);
    return 0;
  }
  if (!command || wantsHelp) {
    printHelp();
    return command ? 0 : 1;
  }

  switch (command) {
    case "host": {
      rejectUnknown(args, HOST_FLAGS);
      const options = hostOptions(args);
      switch (subcommand ?? "run") {
        case "run":
          return runHost(options);
        case "link":
          return linkHost(options, rest[0], stringFlag(args, "name"));
        case "invite":
          return inviteHost(
            options,
            numberFlag(args, "ttl", DEFAULT_INVITE_TTL_MINUTES),
          );
        case "status":
          return statusHost(options);
        default:
          throw new CliError("error.unknownCommand", {
            command: `host ${subcommand}`,
          });
      }
    }
    case "relay": {
      rejectUnknown(args, RELAY_FLAGS);
      return runRelay(relayOptions(args));
    }
    default:
      throw new CliError("error.unknownCommand", { command });
  }
}

/**
 * Leave, rather than waiting for the event loop to empty.
 *
 * A command finishes at a point the Engine does not know about — a pairing
 * callback, an interrupt — and its own follow-up work carries on for a moment
 * after: trusting the peer it just met, opening a replication topic, arming
 * that topic's keepalive. Those timers outlive the teardown that preceded
 * them, so a CLI that waits for silence waits forever. Everything durable is
 * committed by the time a command returns; what is left is a socket we no
 * longer want.
 *
 * stdout is drained first — `process.exit` truncates pending writes to a pipe,
 * which is exactly where a script reads a device-link code from.
 */
async function leave(code: number): Promise<never> {
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => resolve());
  });
  process.exit(code);
}

main(process.argv.slice(2))
  .then((code) => leave(code))
  .catch(async (error: unknown) => {
    if (error instanceof CliError) {
      console.error(error.message);
      console.error(t("error.tryHelp"));
    } else {
      console.error(error);
    }
    await leave(1);
  });
