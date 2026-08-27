/**
 * CLI message catalogue.
 *
 * The app's i18next catalogue is product copy loaded over HTTP by a browser;
 * these are operator messages printed to a terminal, so they live here instead
 * of being bundled into it. English only — a terminal is not the product
 * surface the app's translations are written for.
 */

const EN = {
  // ─── Usage ────────────────────────────────────────────────────────────────
  "usage.summary": "tasfer — run a Tasfer host on your own machine",
  "usage.commands": "Commands",
  "usage.host": "Run the headless host: stay online and sync your spaces",
  "usage.hostLink": "Link this host to your account with a code from the app",
  "usage.hostInvite": "Show a code the app can use to link this host",
  "usage.hostStatus": "Print what this host holds and who it belongs to",
  "usage.export": "Write your spaces to a zip you can keep or import anywhere",
  "usage.update": "Replace this install with the newest published build",
  "usage.options": "Options",
  "usage.optDataDir": "Where the database and assets live",
  "usage.optSignalUrl": "Relay to reach peers through",
  "usage.optTransport":
    "auto (direct if available), direct, or relay-only",
  "usage.optName": "Label for this host in your device list",
  "usage.optTtl": "How long the code stays valid, in minutes",
  "usage.optOut": "Where to write the archive",
  "usage.optSpace": "Export one space instead of all of them",
  "usage.optCheck": "Say what is available without installing it",
  "usage.optHelp": "Show this help",
  "usage.optVersion": "Show the version",
  "usage.more": "Docs: https://tasfer.app/docs/app/headless-host",

  // ─── Host ─────────────────────────────────────────────────────────────────
  "host.dataDir": "Data directory: {{path}}",
  "host.relay": "Relay: {{url}}",
  "host.device": "This device: {{key}}",
  "host.transportDirect": "Transport: direct connections, relay as fallback",
  "host.transportRelay":
    "Transport: relay only — install node-datachannel for direct connections",
  "host.transportRelayChosen": "Transport: relay only, as requested",
  "host.holding": "Holding {{spaces}} and {{pages}}.",
  "host.spaceCount_one": "{{count}} space",
  "host.spaceCount_other": "{{count}} spaces",
  "host.pageCount_one": "{{count}} page",
  "host.pageCount_other": "{{count}} pages",
  "host.notLinked":
    "This host is not linked to your account yet, so it has nothing to sync. Run `tasfer host link <code>` with a code from the app.",
  "host.online": "Host is online. Press Ctrl+C to stop.",
  "host.peerConnected": "Peer connected: {{peer}}",
  "host.peerDisconnected": "Peer disconnected: {{peer}}",
  "host.stopping": "Stopping — finishing the round in flight…",
  "host.stopped": "Stopped.",

  // ─── Linking ──────────────────────────────────────────────────────────────
  "link.needCode": "Pass the code from the app: tasfer host link <code>",
  "link.invalidCode": "That code isn't valid. Check for missing characters.",
  "link.expiredCode": "This code has expired. Generate a new one.",
  "link.waiting": "Waiting for the other device — keep the app open.",
  "link.connected": "Connected — proving the code…",
  "link.peer": "Other device: {{peer}}",
  "link.enrolling": "Setting up this host…",
  "link.handingOver": "Handing over your identity and spaces…",
  "link.reconnecting": "The connection dropped. Trying again…",
  "link.linkedDevice": "Linked. Your spaces are syncing to this host now.",
  "link.joinedSpace": "Joined {{space}}.",
  "link.joinedSpaceUnnamed": "Joined the space.",
  "link.failed": "Linking failed: {{reason}}",
  "link.timedOut":
    "Gave up waiting for the other device. Check both are online and try again.",
  "link.alreadyLinked":
    "This host already belongs to an account. Delete its data directory first to link it to another.",

  // ─── Inviting ─────────────────────────────────────────────────────────────
  "invite.code": "Enter this code in the app under Profile → Link a device:",
  "invite.expires": "It expires in {{minutes}} minutes.",
  "invite.warning":
    "Anyone who uses the code gets full access to everything you have written, until it expires.",
  "invite.linked": "Linked {{peer}}.",

  // ─── Status ───────────────────────────────────────────────────────────────
  "status.person": "Person: {{name}}",
  "status.personUnnamed": "(unnamed)",
  "status.rootKey": "Identity: {{key}}",
  "status.standalone":
    "Standalone — this host has its own identity and is not linked to any account.",
  "status.devices": "Devices",
  "status.deviceSelf": "{{key}} — this host{{note}}",
  "status.deviceOther": "{{key}}{{note}}",
  "status.spaces": "Spaces",
  "status.spaceLine": "{{name}} — {{pages}}",
  "status.noSpaces": "No spaces yet.",

  // ─── Pairing failures (worded as in the app) ──────────────────────────────
  "pair.expired":
    "The code expired before the two devices met. Generate a new one.",
  "pair.network":
    "Could not reach the other device. Check both are online and try again.",
  "pair.invalid-proof":
    "That code did not check out. Copy it again from the other device.",
  "pair.certificate":
    "This device could not vouch for the other one. Try linking again.",
  "pair.enrollment":
    "The connection worked but the handover did not finish. Try linking again.",
  "pair.no-root-identity":
    "This device has no identity to share yet. Finish setting it up first.",
  "pair.bad-device-key":
    "The other device identified itself in a way this one cannot accept.",
  "pair.generic": "Linking failed. Try again.",

  // ─── Exporting ────────────────────────────────────────────────────────────
  "export.collecting": "Exporting {{spaces}}…",
  "export.progress": "{{done}}/{{total}}",
  "export.done": "Wrote {{path}} — {{pages}}, {{size}}.",
  "export.nothingToExport":
    "This host holds no spaces yet, so there is nothing to export.",
  "export.unknownSpace":
    "No space here is called {{space}}. `tasfer host status` lists what this host holds.",
  "export.failed": "Could not write {{name}}: {{reason}}",

  // ─── Updating ─────────────────────────────────────────────────────────────
  "update.checking": "Checking for a newer tasfer…",
  "update.current": "Already on the newest build ({{version}}).",
  "update.available": "{{version}} is out — you are on {{current}}.",
  "update.noReleases":
    "No release carries a tasfer build for this platform yet. Build from the repo for now.",
  "update.downloading": "Downloading {{name}}…",
  "update.done": "Updated to {{version}}. Restart the host to run it.",
  "update.fromSource":
    "This tasfer runs from a source checkout, so there is nothing to replace. Update it with `git pull` and `npm run build` in apps/cli.",
  "update.notWritable":
    "No permission to write to {{path}}. Re-run with the rights that installed it — `sudo tasfer update` for a system-wide install — or unpack the release archive there yourself.",
  "update.checkFailed": "Could not reach GitHub to check for updates (HTTP {{status}}).",
  "update.downloadFailed": "Could not download the update (HTTP {{status}}).",
  "update.noChecksums":
    "That release publishes no checksum for this build, so it was not installed.",
  "update.checksumMismatch":
    "The download did not match its checksum, so it was not installed. Expected {{expected}}, got {{actual}}.",

  // ─── Errors ───────────────────────────────────────────────────────────────
  "error.unknownCommand": "Unknown command: {{command}}",
  "error.unknownOption": "Unknown option: {{option}}",
  "error.optionNeedsValue": "{{option}} needs a value",
  "error.badNumber": "{{option}} must be a number, got: {{value}}",
  "error.tryHelp": "Run `tasfer --help` to see what is available.",
} as const;

export type MessageKey = keyof typeof EN;

/**
 * The stem of a `_one`/`_other` pair. Callers pass the stem plus a `count`
 * and {@link t} picks the form.
 */
export type PluralKey =
  MessageKey extends infer K
    ? K extends `${infer Stem}_other`
      ? Stem
      : never
    : never;

/**
 * A message, interpolated. `count` also selects the `_one`/`_other` form.
 */
export function t(
  key: MessageKey | PluralKey,
  params: Record<string, string | number> = {},
): string {
  let resolved = key as MessageKey;
  if (typeof params.count === "number") {
    const plural = `${key}_${params.count === 1 ? "one" : "other"}`;
    if (plural in EN) resolved = plural as MessageKey;
  }

  const template: string = EN[resolved] ?? resolved;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
