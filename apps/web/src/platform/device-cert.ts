/**
 * Device certificates — binding a device key to a person.
 *
 * A replica's identity keypair names a *device*, not a person: every install
 * generates its own (see `Engine.ensureIdentity`), so three of your own devices
 * are three unrelated public keys to everyone else. A device certificate is the
 * root identity's signature over a device key, which turns "these keys are the
 * same person" into something any peer can verify rather than something each
 * replica has to be told separately.
 *
 * That distinction is what makes personal spaces enforceable. The admission
 * rule for a personal space must be a pure function of replicated state, or
 * your own devices disagree about who belongs; certificates travel in the space
 * log (`device_add`), so every replica computes the same answer.
 *
 * The signed statement deliberately excludes the display name. Names are
 * mutable metadata (`member_set`), and binding one here would invalidate the
 * certificate on every rename.
 *
 * There is no revocation. In a peer-to-peer network with no authority, a
 * "revoked" flag is just another op that a replica holding the old log can
 * ignore, so the app does not pretend to offer one.
 */

import type { CryptoDriver } from "./driver";

const CERT_PREFIX = "tasfer-device-cert:v1";
const HEX_32_BYTES = /^[a-f0-9]{64}$/i;

/** A device key, the root identity that vouches for it, and the proof. */
export interface DeviceCert {
  /** Root ("person") public key, hex. */
  rootKey: string;
  /** Device public key this certificate vouches for, hex. */
  deviceKey: string;
  /** Root's Ed25519 signature over {@link deviceCertMessage}, hex. */
  cert: string;
  /** Unix ms the certificate was issued; part of the signed statement. */
  issuedAt: number;
}

/**
 * Canonical bytes the issuer signs and every verifier reconstructs. Keys are
 * lower-cased so a peer that hex-encodes differently still verifies.
 */
export function deviceCertMessage(
  rootKey: string,
  deviceKey: string,
  issuedAt: number,
): Uint8Array {
  return new TextEncoder().encode(
    `${CERT_PREFIX}|${rootKey.toLowerCase()}|${deviceKey.toLowerCase()}|${issuedAt}`,
  );
}

/** True for a well-formed 32-byte hex Ed25519 key. */
export function isDeviceKeyShaped(key: string): boolean {
  return HEX_32_BYTES.test(key);
}

/**
 * Sign a device key with the root identity's private key.
 *
 * `issuedAt` is a parameter rather than read from the clock here so callers
 * that replay or re-issue produce byte-identical certificates.
 */
export async function issueDeviceCert(
  crypto: CryptoDriver,
  rootPrivateKey: string,
  rootKey: string,
  deviceKey: string,
  issuedAt: number,
): Promise<DeviceCert> {
  if (!isDeviceKeyShaped(rootKey) || !isDeviceKeyShaped(deviceKey)) {
    throw new Error("Device certificates require 32-byte Ed25519 public keys");
  }
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw new Error("Device certificate issuedAt must be a positive integer");
  }
  const cert = await crypto.sign(
    rootPrivateKey,
    deviceCertMessage(rootKey, deviceKey, issuedAt),
  );
  return { rootKey, deviceKey, cert, issuedAt };
}

/**
 * Verify a certificate against the root key it names.
 *
 * This answers "did this root vouch for this device", not "is this root mine" —
 * callers compare {@link DeviceCert.rootKey} against their own root themselves,
 * because a valid certificate from someone else's root is still valid.
 */
export async function verifyDeviceCert(
  crypto: CryptoDriver,
  candidate: DeviceCert,
): Promise<boolean> {
  const { rootKey, deviceKey, cert, issuedAt } = candidate;
  if (!isDeviceKeyShaped(rootKey) || !isDeviceKeyShaped(deviceKey)) {
    return false;
  }
  if (typeof cert !== "string" || !/^[a-f0-9]+$/i.test(cert)) return false;
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) return false;

  try {
    return await crypto.verify(
      rootKey,
      cert,
      deviceCertMessage(rootKey, deviceKey, issuedAt),
    );
  } catch {
    // A malformed signature or key throws inside the driver rather than
    // returning false; an unverifiable certificate is simply not valid.
    return false;
  }
}
