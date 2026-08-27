/**
 * `tasfer` — the self-hosting CLI.
 *
 *   tasfer host      a headless replica that holds their spaces and stays online
 *   tasfer export    write those spaces to a zip, readable and importable
 *   tasfer update    replace this install with the newest published build
 *
 * It needs nothing of ours but an introduction: the host finds its peers
 * through whichever relay it is pointed at, public or your own.
 */

import {
  boolFlag,
  CliError,
  numberFlag,
  parseArgs,
  rejectUnknown,
  stringFlag,
  type Args,
} from "./cli/args";
import { t } from "./cli/messages";
import { updateCli } from "./cli/update";
import { exportSpaces } from "./host/export";
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
import { VERSION } from "./version";

const GLOBAL_FLAGS = ["help", "h", "version", "v"] as const;
const UPDATE_FLAGS = [...GLOBAL_FLAGS, "check"] as const;
const HOST_FLAGS = [
  ...GLOBAL_FLAGS,
  "data-dir",
  "signal-url",
  "transport",
  "name",
  "ttl",
] as const;
const EXPORT_FLAGS = [
  ...GLOBAL_FLAGS,
  "data-dir",
  "signal-url",
  "transport",
  "out",
  "space",
] as const;

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
  console.log(line("export [file]", t("usage.export")));
  console.log(line("update", t("usage.update")));
  console.log("");
  console.log(`${t("usage.options")}:`);
  console.log(line("--data-dir <path>", t("usage.optDataDir")));
  console.log(line("--signal-url <url>", t("usage.optSignalUrl")));
  console.log(line("--transport <mode>", t("usage.optTransport")));
  console.log(line("--name <label>", t("usage.optName")));
  console.log(line("--ttl <minutes>", t("usage.optTtl")));
  console.log(line("--out <file>", t("usage.optOut")));
  console.log(line("--space <name>", t("usage.optSpace")));
  console.log(line("--check", t("usage.optCheck")));
  console.log(line("--help, -h", t("usage.optHelp")));
  console.log(line("--version, -v", t("usage.optVersion")));
  console.log("");
  console.log(t("usage.more"));
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

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
    case "export": {
      rejectUnknown(args, EXPORT_FLAGS);
      // `tasfer export backup.zip` reads as well as `--out backup.zip`, and
      // the flag wins when both are given.
      return exportSpaces(hostOptions(args), {
        out: stringFlag(args, "out") ?? subcommand,
        space: stringFlag(args, "space"),
      });
    }
    case "update": {
      rejectUnknown(args, UPDATE_FLAGS);
      return updateCli({ checkOnly: boolFlag(args, "check") });
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
 * which is exactly where a script reads a device-link code from. A reader that
 * left early (`tasfer host status | head`) closes that pipe, and the drain then
 * fails with EPIPE: nothing to report, the output went where it was going.
 */
async function leave(code: number): Promise<never> {
  await new Promise<void>((resolve) => {
    process.stdout.on("error", () => resolve());
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
