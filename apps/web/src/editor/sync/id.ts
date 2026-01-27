/**
 * ID Generation Utilities
 *
 * Provides unique ID generation for:
 * - Peer IDs (unique per device/session)
 * - Operation IDs (unique per operation)
 * - Block IDs (unique per block)
 * - Character IDs (unique per character)
 *
 * ID format: `${peerId}:${counter}` ensures global uniqueness
 * when peerId is unique.
 */

/**
 * Generate a unique peer ID.
 * Uses crypto.randomUUID() if available, falls back to custom generation.
 */
export function generatePeerId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    // Use short form of UUID (first 8 chars) for more compact IDs
    return crypto.randomUUID().slice(0, 4);
  }

  // Fallback: generate random hex string
  const array: number[] = [0, 0, 0, 0];
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const tempArray = new Uint8Array(4);
    crypto.getRandomValues(tempArray);
    for (let i = 0; i < 4; i++) {
      array[i] = tempArray[i];
    }
  } else {
    // Last resort: Math.random (not cryptographically secure)
    for (let i = 0; i < array.length; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
  }

  return array
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create an ID generator bound to a peer ID.
 * Returns a function that generates unique IDs in the format `${peerId}:${counter}`.
 *
 * @param peerId - The peer's unique identifier
 * @param startCounter - Optional starting counter (default: 0)
 * @returns A function that generates unique IDs
 *
 * @example
 * const genId = createIdGenerator("abc123");
 * genId(); // "abc123:0"
 * genId(); // "abc123:1"
 */
export function createIdGenerator(
  peerId: string,
  startCounter: number = 0
): () => string {
  let counter = startCounter;

  return () => {
    const id = `${peerId}:${counter}`;
    counter++;
    return id;
  };
}

/**
 * Extract the peer ID from a compound ID.
 *
 * @example
 * extractPeerId("abc123:42"); // "abc123"
 */
export function extractPeerId(id: string): string {
  const colonIndex = id.indexOf(":");
  if (colonIndex === -1) {
    return id;
  }
  return id.slice(0, colonIndex);
}

/**
 * Extract the counter from a compound ID.
 *
 * @example
 * extractCounter("abc123:42"); // 42
 */
export function extractCounter(id: string): number {
  const colonIndex = id.indexOf(":");
  if (colonIndex === -1) {
    return 0;
  }
  return parseInt(id.slice(colonIndex + 1), 10);
}

/**
 * Compare two IDs for ordering.
 * Orders by counter first (numerically), then by peerId (lexicographically).
 * This provides a deterministic total ordering.
 */
export function compareIds(a: string, b: string): number {
  const counterA = extractCounter(a);
  const counterB = extractCounter(b);

  if (counterA !== counterB) {
    return counterA - counterB;
  }

  const peerA = extractPeerId(a);
  const peerB = extractPeerId(b);

  return peerA.localeCompare(peerB);
}

/**
 * Generate a unique block ID.
 * Uses the ID generator to create block IDs with a "b" prefix for clarity.
 *
 * @param genId - ID generator function
 * @returns Block ID in format `b-${peerId}:${counter}`
 */
export function generateBlockId(genId: () => string): string {
  return `b-${genId()}`;
}

/**
 * Generate unique character IDs for a string.
 * Creates an array of CharData objects with unique IDs.
 *
 * @param genId - ID generator function
 * @param text - Text to generate character IDs for
 * @returns Array of CharData objects
 */
export function generateCharIds(
  genId: () => string,
  text: string
): Array<{ id: string; char: string }> {
  return Array.from(text).map((char) => ({
    id: genId(),
    char,
  }));
}
