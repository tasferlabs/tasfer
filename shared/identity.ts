/**
 * Generic identity allocation contract shared by persisted editor features.
 *
 * An allocator owns one collision domain. Every returned identity MUST use the
 * `<origin>:<non-negative decimal counter>` shape, be fresh, and have a counter
 * strictly greater than the allocator's previous result. Before editing an
 * existing character RGA, the allocator MUST be advanced so its next counter
 * is greater than every node/character identity already observed in that
 * document. The editor's CRDT binding maintains that invariant on load/replay.
 *
 * Live collaborative code should therefore use the allocator owned by its CRDT
 * binding. Parsers, imports, and tests may use the deterministic scoped
 * implementation below when their scope is stable and unique in the target
 * document.
 */
export interface IdentityAllocator {
  nextId(): string;
}

/** Parsed wire identity returned by a conforming allocator. */
export interface AllocatedIdentity {
  readonly origin: string;
  readonly counter: number;
}

/** Validate and parse the allocator's canonical compound identity shape. */
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
 * Create a deterministic allocator for an import/test scope.
 *
 * The emitted `<scope>:<counter>` shape is also a valid editor character-RGA
 * identity. It is deliberately not random: equal inputs with the same scope
 * can construct equal initial trees on different peers. Do not create one per
 * live edit; live edits must use the page's CRDT-owned allocator instead. When
 * a test edits an existing RGA, pass a `startCounter` above every identity in
 * the fixture, matching the binding's load-time advancement.
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
