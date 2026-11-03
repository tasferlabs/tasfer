/**
 * Clock check against the relay.
 *
 * A pairing code carries an absolute expiry, stamped with the clock of the
 * device that minted it and checked against the clock of the device that
 * reads it. A host on a box without time sync — a VM, a Pi with no RTC — can
 * be minutes off, and then every code it makes reaches the app already
 * expired, or every code from the app looks expired here. Nothing about the
 * code says why, so the host says it instead.
 *
 * The relay is the reference because every pairing already talks to it, and
 * its HTTP `Date` header is the server's clock. One second of resolution is
 * plenty: anything worth warning about is minutes off.
 */

import { t } from "../cli/messages";

/** Below this, the clock is right enough for a code that lives minutes. */
const SKEW_WARN_MS = 60_000;

/** The check is advice, so it never holds a command up for long. */
const REQUEST_TIMEOUT_MS = 3000;

/** The relay's HTTP origin, from the WebSocket URL it is configured as. */
function relayOrigin(signalUrl: string): string | null {
  try {
    const url = new URL(signalUrl);
    if (url.protocol === "wss:") url.protocol = "https:";
    else if (url.protocol === "ws:") url.protocol = "http:";
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * How far this machine's clock is ahead of the relay's, in ms (negative when
 * behind). Null when the relay cannot be reached or sends no `Date`.
 */
export async function measureClockSkew(signalUrl: string): Promise<number | null> {
  const origin = relayOrigin(signalUrl);
  if (!origin) return null;
  try {
    const sent = Date.now();
    const response = await fetch(origin, {
      method: "HEAD",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const received = Date.now();
    const header = response.headers.get("date");
    if (!header) return null;
    const serverMs = Date.parse(header);
    if (Number.isNaN(serverMs)) return null;
    // `Date` is truncated to the second; its midpoint is the best guess, as
    // the midpoint of the round trip is for when the server read its clock.
    return (sent + received) / 2 - (serverMs + 500);
  } catch {
    return null;
  }
}

/** Print a warning when this machine's clock is far enough off to break codes. */
export async function warnIfClockSkewed(signalUrl: string): Promise<void> {
  const skew = await measureClockSkew(signalUrl);
  if (skew === null || Math.abs(skew) < SKEW_WARN_MS) return;
  const count = Math.max(1, Math.round(Math.abs(skew) / 60_000));
  console.warn(t(skew < 0 ? "clock.slow" : "clock.fast", { count }));
  console.warn(t("clock.fix"));
}
