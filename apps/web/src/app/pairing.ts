/**
 * Shared handling for the two screens that wait on a pairing handshake:
 * joining a space, and linking a device.
 *
 * The replicator reports failures as codes rather than sentences — it runs
 * below the UI, and on some platforms inside a worker — so the wording lives
 * here, next to the screens that show it.
 */

import type { TFunction } from "i18next";
import type { PairError } from "@/platform/types";

/**
 * Failures worth retrying by themselves. Everything else is a decision the
 * user has to make (a fresh code, a different flow), so retrying it would only
 * spin. A rejected call with no code at all lands here too: it failed before
 * pairing could report anything, which is almost always the network.
 */
export function isTransientPairError(code: string): boolean {
  return code === "network";
}

/** First backoff step, doubling per attempt. */
const RETRY_BASE_MS = 2000;
/** Ceiling — a signaling socket that is down tends to stay down for a while. */
const RETRY_CAP_MS = 15_000;

/**
 * How many times a wait restarts itself before it asks the user. The transport
 * reconnects on its own, so these attempts only cover a session that never got
 * off the ground; several minutes of silence means something else is wrong.
 */
export const MAX_PAIR_RETRIES = 5;

export function pairRetryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
}

/** A pairing failure in words. Unknown codes fall back rather than leak. */
export function pairErrorMessage(t: TFunction, code: string): string {
  switch (code as PairError) {
    case "expired":
      return t(
        "pairing.errorExpired",
        "The code expired before the two devices met. Generate a new one.",
      );
    case "network":
      return t(
        "pairing.errorNetwork",
        "Could not reach the other device. Check both are online and try again.",
      );
    case "invalid-proof":
      return t(
        "pairing.errorProof",
        "That code did not check out. Copy it again from the other device.",
      );
    case "certificate":
      return t(
        "pairing.errorCertificate",
        "This device could not vouch for the other one. Try linking again.",
      );
    case "enrollment":
      return t(
        "pairing.errorEnrollment",
        "The connection worked but the handover did not finish. Try linking again.",
      );
    case "no-root-identity":
      return t(
        "pairing.errorNoIdentity",
        "This device has no identity to share yet. Finish setting it up first.",
      );
    case "bad-device-key":
      return t(
        "pairing.errorBadKey",
        "The other device identified itself in a way this one cannot accept.",
      );
    default:
      return t("pairing.errorGeneric", "Linking failed. Try again.");
  }
}
