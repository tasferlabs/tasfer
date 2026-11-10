/**
 * `tasfer` — the self-hosting CLI.
 *
 *   tasfer host      a headless replica that holds their spaces and stays online
 *   tasfer host restart   restart that replica in place, onto a new build
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
import {
  acceptedOptions,
  printCommandHelp,
  printOverview,
  resolveCommand,
  type CommandSpec,
} from "./cli/help";
import { t } from "./cli/messages";
import { updateCli } from "./cli/update";
import { exportSpaces } from "./host/export";
import {
  DEFAULT_INVITE_TTL_MINUTES,
  inviteHost,
  linkHost,
  restartHost,
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

function hostOptions(args: Args): HostOptions {
  const transport = stringFlag(args, "transport", "auto");
  if (transport !== "auto" && transport !== "direct" && transport !== "relay") {
    throw new CliError("error.unknownOption", {
      option: `--transport ${transport}`,
    });
  }
  return {
    dataDir: stringFlag(args, "data-dir") ?? defaultDataDir(),
    signalUrl: signalUrl(args),
    transport: transport as Transport,
  };
}

function signalUrl(args?: Args): string {
  return (
    (args && stringFlag(args, "signal-url")) ??
    process.env.TASFER_SIGNAL_URL ??
    DEFAULT_SIGNAL_URL
  );
}

function run(spec: CommandSpec, args: Args, rest: string[]): Promise<number> {
  switch (spec.id) {
    case "host":
      return runHost(hostOptions(args), {
        autoUpdate: boolFlag(args, "auto-update"),
      });
    case "host link":
      return linkHost(hostOptions(args), rest[0], stringFlag(args, "name"));
    case "host invite":
      return inviteHost(
        hostOptions(args),
        numberFlag(args, "ttl", DEFAULT_INVITE_TTL_MINUTES),
      );
    case "host status":
      return statusHost(hostOptions(args));
    case "host restart":
      return restartHost(hostOptions(args));
    case "export":
      // `tasfer export backup.zip` reads as well as `--out backup.zip`, and
      // the flag wins when both are given.
      return exportSpaces(hostOptions(args), {
        out: stringFlag(args, "out") ?? rest[0],
        space: stringFlag(args, "space"),
      });
    case "update":
      return updateCli({ checkOnly: boolFlag(args, "check") });
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const wantsHelp = args.flags.has("help") || args.flags.has("h");

  if (args.flags.has("version") || args.flags.has("v")) {
    console.log(VERSION);
    return 0;
  }
  if (args.positionals.length === 0) {
    printOverview();
    // Bare `tasfer` is a mistake a script should notice; `--help` is not.
    return wantsHelp ? 0 : 1;
  }

  const resolved = resolveCommand(args.positionals);
  if (resolved.kind === "unknown") {
    console.error(t("error.unknownCommand", { command: resolved.typed }));
    console.error(t("error.tryHelp"));
    return 1;
  }

  const { spec, rest } = resolved;
  if (wantsHelp) {
    printCommandHelp(spec, {
      dataDir: defaultDataDir(),
      signalUrl: signalUrl(),
      inviteTtlMinutes: DEFAULT_INVITE_TTL_MINUTES,
    });
    return 0;
  }

  try {
    rejectUnknown(args, acceptedOptions(spec));
    return await run(spec, args, rest);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    console.error(error.message);
    if (error.isUsage) {
      console.error(t("error.tryCommandHelp", { command: spec.id }));
    }
    return 1;
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
