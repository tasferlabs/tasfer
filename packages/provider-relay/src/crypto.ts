/**
 * Frame encryption for the relay transport.
 *
 * A relay is a party to every byte it forwards, so `data` payloads are sealed
 * before they reach it: AES-256-GCM under a key derived from the room secret
 * with HKDF-SHA256, salted by the room name. The relay sees a nonce and a
 * ciphertext it cannot decrypt and cannot alter without failing the GCM tag.
 *
 * Sender and recipient ids are bound in as additional authenticated data, so a
 * relay cannot re-attribute a captured frame to a different peer. Within a
 * room the key is shared, so this is confidentiality and integrity against the
 * *relay* — peers holding the same secret can still forge each other's ids.
 * Per-peer authenticity needs signatures, which this transport does not do.
 */

const NONCE_BYTES = 12;
const KEY_INFO = "tasfer/provider-relay/v1";

/** A room key that seals and opens `data` payloads. */
export interface FrameCipher {
  seal(plaintext: Uint8Array, aad: string): Promise<Uint8Array>;
  /** Opened bytes, or null if the frame was truncated, tampered with, or sealed under another secret. */
  open(sealed: Uint8Array, aad: string): Promise<Uint8Array | null>;
}

const utf8 = new TextEncoder();

/**
 * WebCrypto takes ArrayBuffer-backed views only, while a `Uint8Array` off the
 * transport may be backed by a SharedArrayBuffer. Copies only when it has to.
 */
function view(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

/**
 * Derive a room key from a shared secret. The secret is stretched with HKDF
 * rather than used directly, so a human-typed passphrase is as usable as 32
 * random bytes; `room` is the salt, so the same passphrase in two rooms yields
 * two unrelated keys.
 */
export async function createFrameCipher(
  secret: string | Uint8Array,
  room: string,
): Promise<FrameCipher> {
  const ikm = typeof secret === "string" ? utf8.encode(secret) : secret;
  if (ikm.length === 0) {
    throw new Error("[provider-relay] secret must not be empty");
  }
  const base = await crypto.subtle.importKey("raw", view(ikm), "HKDF", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8.encode(room),
      info: utf8.encode(KEY_INFO),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    async seal(plaintext, aad) {
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: utf8.encode(aad) },
        key,
        view(plaintext),
      );
      const sealed = new Uint8Array(NONCE_BYTES + ciphertext.byteLength);
      sealed.set(nonce);
      sealed.set(new Uint8Array(ciphertext), NONCE_BYTES);
      return sealed;
    },
    async open(sealed, aad) {
      if (sealed.length <= NONCE_BYTES) return null;
      try {
        const plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: view(sealed.subarray(0, NONCE_BYTES)),
            additionalData: utf8.encode(aad),
          },
          key,
          view(sealed.subarray(NONCE_BYTES)),
        );
        return new Uint8Array(plaintext);
      } catch {
        // Authentication failure. The frame came off an untrusted wire, so a
        // bad tag is an expected outcome, not an exception to propagate.
        return null;
      }
    },
  };
}
