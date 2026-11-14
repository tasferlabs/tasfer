/**
 * Hands out ids for saved editor content, one per `nextId()` call.
 *
 * Each id must look like `<origin>:<counter>`, where the counter is a whole
 * number of 0 or more. Each id must be new, with a counter bigger than the last
 * one. Before editing text that already exists, the allocator must move past
 * every id already in that document, or new ids can clash with old ones. The
 * editor's own allocator does this when it loads a page, so live editing should
 * use that one. Imports, parsers and tests can use
 * {@link createDeterministicIdentityAllocator} when their scope is unique in
 * the document.
 */
export interface IdentityAllocator {
  nextId(): string;
}

/**
 * An id split into its two parts: `origin`, the part before the colon, and
 * `counter`, the number after it. {@link parseAllocatedIdentity} returns it.
 */
export interface AllocatedIdentity {
  readonly origin: string;
  readonly counter: number;
}

/**
 * Split an id like `scope:12` into its origin and counter. Returns null when
 * `value` is not a string of that shape: a non-empty origin, a colon, then a
 * whole number with no leading zeros that fits in a safe integer.
 */
export function parseAllocatedIdentity(
  value: unknown,
): AllocatedIdentity | null {
  if (typeof value !== "string") return null;
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const origin = value.slice(0, colon);
  const counterText = value.slice(colon + 1);
  if (!/^(0|[1-9]\d*)$/.test(counterText)) return null;
  const counter = Number(counterText);
  return Number.isSafeInteger(counter) ? { origin, counter } : null;
}

/**
 * Create an id maker that hands out `<scope>:0`, `<scope>:1`, and so on. The
 * same scope always gives the same ids, so two devices that import the same
 * input build the same document. Use it for imports and tests only. Live edits
 * must use the editor's own allocator, or ids can clash. When a test edits text
 * that already exists, pass a `startCounter` above every id already in it.
 *
 * Throws if `scope` is empty or contains `:`, or if `startCounter` is not a
 * whole number of 0 or more.
 */
export function createDeterministicIdentityAllocator(
  scope: string,
  startCounter = 0,
): IdentityAllocator {
  if (scope.length === 0 || scope.includes(":")) {
    throw new Error(
      "Identity scope must be non-empty and must not contain ':'",
    );
  }
  if (!Number.isSafeInteger(startCounter) || startCounter < 0) {
    throw new Error("Identity counter must be a non-negative safe integer");
  }

  let counter = startCounter;
  return {
    nextId(): string {
      if (!Number.isSafeInteger(counter)) {
        throw new Error("Identity counter exhausted its safe integer range");
      }
      return `${scope}:${counter++}`;
    },
  };
}
