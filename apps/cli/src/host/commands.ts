/**
 * The `tasfer host` commands.
 *
 * Each one opens the replica, does its work, and closes it. They are separate
 * processes on purpose: pairing rewrites the identity a running host is
 * replicating under, so it happens while the host is stopped rather than
 * underneath it.
 */

import os from "node:os";
import { decodeInvite, encodeInvite, isDeviceLink } from "@/app/inviteCode";
import type { PairCallbacks, SpaceInvite } from "@/platform/types";
import { t, type MessageKey } from "../cli/messages";
import { CliError } from "../cli/args";
import { openHost, type Host, type HostOptions } from "./runtime";

/** Heartbeat that holds the event loop open while the host runs. */
const STAY_ALIVE_MS = 60_000;

/** How long a pairing command waits before deciding nobody is coming. */
const PAIR_TIMEOUT_MS = 3 * 60 * 1000;

/** Default life of a code minted here, matching the app's device-link default. */
export const DEFAULT_INVITE_TTL_MINUTES = 10;

const SHORT_KEY = 12;

function shortKey(key: string): string {
  return key.slice(0, SHORT_KEY);
}

/** A pairing failure in words, mirroring the app's wording. */
function pairErrorMessage(code: string): string {
  const key = `pair.${code}` as MessageKey;
  const message = t(key);
  return message === key ? t("pair.generic") : message;
}

function parseCode(code: string | undefined): SpaceInvite {
  if (!code) throw new CliError("link.needCode");
  const invite = decodeInvite(code);
  if (!invite) throw new CliError("link.invalidCode");
  if (invite.expiresAt <= Date.now()) throw new CliError("link.expiredCode");
  return invite;
}

// =============================================================================
// host run
// =============================================================================

export async function runHost(options: HostOptions): Promise<number> {
  const host = await openHost(options);
  const identity = await host.engine.identity.get();
  const spaces = await printHeader(host, options, identity.publicKey);

  const devices = await host.engine.devices.list();
  // One device and nothing to hold: this replica was never linked, so it will
  // sit on the relay talking to nobody. Say so rather than look healthy.
  if (devices.length <= 1 && spaces === 0) console.warn(t("host.notLinked"));

  await host.replicator.start();
  // An invite this host accepted but never finished (killed mid-handshake)
  // resumes here, the same way the app resumes one after a restart.
  await host.engine.resumePendingInvites();

  const known = new Set<string>();
  const unsubscribe = host.engine.sync.onConnectedPeersChange((peers) => {
    for (const peer of peers) {
      if (!known.has(peer)) {
        known.add(peer);
        console.log(t("host.peerConnected", { peer: shortKey(peer) }));
      }
    }
    for (const peer of [...known]) {
      if (!peers.includes(peer)) {
        known.delete(peer);
        console.log(t("host.peerDisconnected", { peer: shortKey(peer) }));
      }
    }
  });

  console.log(t("host.online"));

  await waitForShutdown();
  unsubscribe();

  console.log(t("host.stopping"));
  await host.close();
  console.log(t("host.stopped"));
  return 0;
}

/**
 * Resolve on the first SIGINT/SIGTERM, so shutdown can be orderly.
 *
 * The timer is what keeps the process alive. Signal handlers do not hold the
 * event loop open, and a host with nothing to talk to yet — freshly linked, or
 * every peer offline — has no socket or timer of its own either, so without
 * this it would print that it is online and immediately exit.
 */
function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const alive = setInterval(() => {}, STAY_ALIVE_MS);
    const stop = () => {
      clearInterval(alive);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

// =============================================================================
// host link
// =============================================================================

export async function linkHost(
  options: HostOptions,
  code: string | undefined,
  name: string | undefined,
): Promise<number> {
  const invite = parseCode(code);
  const host = await openHost(options);

  try {
    if (isDeviceLink(invite)) {
      const devices = await host.engine.devices.list();
      // A device link replaces this replica's root identity. Refusing when it
      // already has one keeps a populated host from being quietly re-homed.
      if (devices.length > 1) throw new CliError("link.alreadyLinked");
    }

    await host.replicator.start();

    const outcome = await pair(
      (callbacks) =>
        isDeviceLink(invite)
          ? host.engine.pairing.acceptDeviceLink(invite, callbacks)
          : host.engine.pairing.acceptInvite(invite, callbacks),
      isDeviceLink(invite) ? "enrolled" : "handshake",
    );

    if (outcome.error) {
      console.error(t("link.failed", { reason: pairErrorMessage(outcome.error) }));
      return 1;
    }
    if (!outcome.done) {
      console.error(t("link.timedOut"));
      return 1;
    }

    if (isDeviceLink(invite)) {
      await labelThisHost(host, name);
      console.log(t("link.linkedDevice"));
    } else {
      console.log(
        outcome.spaceName
          ? t("link.joinedSpace", { space: outcome.spaceName })
          : t("link.joinedSpaceUnnamed"),
      );
    }
    return 0;
  } finally {
    await host.close();
  }
}

// =============================================================================
// host invite
// =============================================================================

export async function inviteHost(
  options: HostOptions,
  ttlMinutes: number,
): Promise<number> {
  const host = await openHost(options);

  try {
    await host.replicator.start();
    const invite = await host.engine.pairing.createDeviceLink(
      ttlMinutes * 60 * 1000,
    );

    console.log(t("invite.code"));
    console.log("");
    console.log(encodeInvite(invite));
    console.log("");
    console.log(t("invite.expires", { minutes: ttlMinutes }));
    console.log(t("invite.warning"));

    const outcome = await pair(
      (callbacks) => host.engine.pairing.waitForDevice(invite, callbacks),
      "handover",
      invite.expiresAt - Date.now(),
    );

    if (outcome.error) {
      console.error(t("link.failed", { reason: pairErrorMessage(outcome.error) }));
      return 1;
    }
    if (!outcome.done) {
      console.error(t("link.timedOut"));
      return 1;
    }
    console.log(t("invite.linked", { peer: shortKey(outcome.peerKey ?? "") }));
    return 0;
  } finally {
    await host.close();
  }
}

// =============================================================================
// host status
// =============================================================================

export async function statusHost(options: HostOptions): Promise<number> {
  const host = await openHost(options);

  try {
    const identity = await host.engine.identity.get();
    const devices = await host.engine.devices.list();
    const spaces = await host.engine.spaces.list();

    console.log(t("host.dataDir", { path: host.dataDir }));
    console.log(t("host.device", { key: shortKey(identity.publicKey) }));
    console.log(
      t("status.person", { name: identity.name || t("status.personUnnamed") }),
    );
    if (identity.rootPublicKey) {
      console.log(t("status.rootKey", { key: shortKey(identity.rootPublicKey) }));
    }
    if (devices.length <= 1) console.log(t("status.standalone"));

    if (devices.length > 1) {
      console.log("");
      console.log(t("status.devices"));
      for (const device of devices) {
        const note = device.note ? ` (${device.note})` : "";
        const self = device.current;
        console.log(
          "  " +
            t(self ? "status.deviceSelf" : "status.deviceOther", {
              key: shortKey(device.publicKey),
              note,
            }),
        );
      }
    }

    console.log("");
    console.log(t("status.spaces"));
    if (spaces.length === 0) {
      console.log("  " + t("status.noSpaces"));
    }
    for (const space of spaces) {
      const pages = await countPages(host, space.id);
      console.log(
        "  " +
          t("status.spaceLine", {
            name: space.name,
            pages: t("host.pageCount", { count: pages }),
          }),
      );
    }
    return 0;
  } finally {
    await host.close();
  }
}

// =============================================================================
// Shared helpers
// =============================================================================

interface PairOutcome {
  done: boolean;
  error?: string;
  peerKey?: string;
  spaceName?: string;
}

/**
 * What counts as done for this side of a pairing.
 *
 * `onComplete` only means the code checked out. A device link is not finished
 * there on either side: the acceptor waits for `onEnrolled`, when the identity
 * and spaces it was handed have been adopted, and the inviter for
 * `onHandover`, when that payload has gone out. A CLI that exits at
 * `onComplete` tears the transport down mid-handover.
 */
type PairEnd = "handshake" | "enrolled" | "handover";

/** Drive one pairing session to an outcome. */
function pair(
  begin: (callbacks: PairCallbacks) => Promise<void>,
  endsAt: PairEnd,
  timeoutMs = PAIR_TIMEOUT_MS,
): Promise<PairOutcome> {
  return new Promise<PairOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: PairOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ done: false }), Math.max(0, timeoutMs));

    let peerKey: string | undefined;
    let spaceName: string | undefined;

    // The session outlives the outcome — the transport keeps reconnecting
    // while the command tears down — so nothing reports after it is settled.
    const say = (message: string) => {
      if (!settled) console.log(message);
    };

    const callbacks: PairCallbacks = {
      onConnected: () => say(t("link.connected")),
      onReconnecting: () => say(t("link.reconnecting")),
      onPeerIdentity: (peer) => {
        peerKey = peer.publicKey;
        say(t("link.peer", { peer: shortKey(peer.publicKey) }));
      },
      onComplete: (peer, name) => {
        peerKey = peer.publicKey;
        spaceName = name;
        if (endsAt !== "handshake") {
          say(t(endsAt === "handover" ? "link.handingOver" : "link.enrolling"));
          return;
        }
        finish({ done: true, peerKey, spaceName });
      },
      onEnrolled: () => {
        if (endsAt === "enrolled") finish({ done: true, peerKey, spaceName });
      },
      onHandover: () => {
        if (endsAt === "handover") finish({ done: true, peerKey, spaceName });
      },
      onError: (error) => finish({ done: false, error }),
    };

    console.log(t("link.waiting"));
    begin(callbacks).catch((e: unknown) => {
      finish({ done: false, error: e instanceof Error ? e.message : String(e) });
    });
  });
}

/**
 * Give the host a name in the person's device list. Without one it is an
 * anonymous key next to their laptop and phone, which is exactly the device
 * they most need to recognise.
 */
async function labelThisHost(host: Host, name: string | undefined): Promise<void> {
  const identity = await host.engine.identity.get();
  try {
    await host.engine.devices.setNote(
      identity.publicKey,
      name || `${os.hostname()} (host)`,
    );
  } catch (e) {
    // A label is a convenience; failing to write one must not fail the link.
    console.warn("[host] could not label this device:", e);
  }
}

/**
 * Pages held for a space. There is no typed accessor for a total — `pages.list`
 * answers about one level of the tree — and this is a readout, not app logic.
 */
async function countPages(host: Host, spaceId: string): Promise<number> {
  const [row] = await host.engine.db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pages WHERE space_id = ? AND archived_at IS NULL",
    [spaceId],
  );
  return Number(row?.n ?? 0);
}

/** Print what this host is and holds. Returns how many spaces that is. */
async function printHeader(
  host: Host,
  options: HostOptions,
  deviceKey: string,
): Promise<number> {
  console.log(t("host.dataDir", { path: host.dataDir }));
  console.log(t("host.device", { key: shortKey(deviceKey) }));
  console.log(t("host.relay", { url: options.signalUrl }));
  console.log(
    host.direct
      ? t("host.transportDirect")
      : t(host.relayByChoice ? "host.transportRelayChosen" : "host.transportRelay"),
  );

  const spaces = await host.engine.spaces.list();
  let pages = 0;
  for (const space of spaces) pages += await countPages(host, space.id);
  console.log(
    t("host.holding", {
      spaces: t("host.spaceCount", { count: spaces.length }),
      pages: t("host.pageCount", { count: pages }),
    }),
  );
  return spaces.length;
}
