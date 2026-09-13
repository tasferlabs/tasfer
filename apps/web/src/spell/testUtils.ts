/**
 * Test doubles for the spell service layer. Not a test file itself (vitest
 * only picks up `*.test.ts`).
 */
import type { OwnPrefsStore } from "@/app/contexts/OwnPrefsContext";
import type { Script, SpellRequest, SpellResponse } from "@tasfer/spell";

/** In-memory stand-in for OwnPrefsStore: same get/set/subscribe/getSnapshot surface, no platform. */
export class FakeOwnPrefsStore {
  private snapshot = { values: {} as Record<string, unknown>, loaded: true };
  private listeners = new Set<() => void>();
  /** Every `set` call, in order — lets tests assert on tombstones (`null`). */
  readonly writes: Array<[string, unknown]> = [];

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  get<T>(key: string, fallback: T): T {
    const value = this.snapshot.values[key];
    return value === undefined || value === null ? fallback : (value as T);
  }

  set(key: string, value: unknown): void {
    this.writes.push([key, value]);
    this.commit({ ...this.snapshot.values, [key]: value });
  }

  /** Simulate a change arriving from another device. */
  receive(changed: Record<string, unknown>): void {
    this.commit({ ...this.snapshot.values, ...changed });
  }

  /** Only writes when the key has no answer at all — mirrors `platform.prefs.seed`. */
  async seed(key: string, value: unknown): Promise<boolean> {
    if (this.snapshot.values[key] != null) return false;
    this.seeds.push([key, value]);
    this.commit({ ...this.snapshot.values, [key]: value });
    return true;
  }

  /** Every `seed` call that actually wrote, in order. */
  readonly seeds: Array<[string, unknown]> = [];

  whenLoaded(): Promise<void> {
    return Promise.resolve();
  }

  /** Raw stored value (including `null` tombstones). */
  raw(key: string): unknown {
    return this.snapshot.values[key];
  }

  private commit(values: Record<string, unknown>) {
    this.snapshot = { values, loaded: true };
    for (const l of this.listeners) l();
  }

  asStore(): OwnPrefsStore {
    return this as unknown as OwnPrefsStore;
  }
}

/**
 * In-memory content-addressed asset store, standing in for the platform one.
 *
 * `get` is the call that would cross the network, so `remote` is the second
 * device: bytes in there are pulled into `local` on demand, and clearing it
 * models a sibling that is not reachable right now.
 */
export class FakeDictionaryAssets {
  /** Bytes on this device. */
  readonly local = new Map<string, Uint8Array>();
  /** Bytes only a sibling has, pulled in by `get`. */
  readonly remote = new Map<string, Uint8Array>();
  /** Hashes `get` had to fetch from the sibling, in order. */
  readonly pulled: string[] = [];

  async put(bytes: Uint8Array, _ext: string): Promise<string> {
    const hash = fakeHash(bytes);
    this.local.set(hash, bytes);
    return hash;
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const here = this.local.get(hash);
    if (here) return here;
    const there = this.remote.get(hash);
    if (!there) return null;
    this.pulled.push(hash);
    this.local.set(hash, there);
    return there;
  }

  async has(hash: string): Promise<boolean> {
    return this.local.has(hash);
  }

  async drop(hash: string): Promise<void> {
    this.local.delete(hash);
  }

  /** Move everything this device holds to the sibling — "a fresh device". */
  moveToSibling(): void {
    for (const [hash, bytes] of this.local) this.remote.set(hash, bytes);
    this.local.clear();
  }
}

/** 64 hex chars derived from the bytes: content-addressed, and passes the hash check. */
function fakeHash(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b + byte + 1, 0x85ebca6b) >>> 0;
  }
  const word = (n: number) => n.toString(16).padStart(8, "0");
  return (word(a) + word(b) + word((a ^ b) >>> 0) + word(bytes.length)).repeat(
    2,
  );
}

// --- @tasfer/spell stand-ins -------------------------------------------------
// The service layer only needs `scriptOf` and `normalizeForLookup` at runtime;
// these mirror the package contract so the tests run whether or not the
// package build is present.

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const LATIN = /[A-Za-z\u00C0-\u024F]/;
const TASHKEEL_TATWEEL = /[\u064B-\u0670\u0640]/g;

export function scriptOf(word: string): Script {
  const arab = ARABIC.test(word);
  const latn = LATIN.test(word);
  if (arab && latn) return "mixed";
  if (arab) return "arab";
  if (latn) return "latn";
  return "other";
}

export function normalizeForLookup(word: string, script: Script): string {
  const nfc = word.normalize("NFC");
  return script === "arab" ? nfc.replace(TASHKEEL_TATWEEL, "") : nfc;
}

export const spellMock = { scriptOf, normalizeForLookup };

// --- worker double -------------------------------------------------------------

export interface FakeWorkerOptions {
  /** Produce the `checked` results for a check request. */
  onCheck?: (
    req: Extract<SpellRequest, { type: "check" }>,
  ) => Extract<SpellResponse, { type: "checked" }>["results"];
  onSuggest?: (req: Extract<SpellRequest, { type: "suggest" }>) => string[];
  /** Fail dictionary loads for these langs. */
  failDictionaries?: string[];
}

/** Replies asynchronously (a microtask later) like a real worker would. */
export class FakeWorker {
  readonly posted: Array<{ msg: SpellRequest; transfer: Transferable[] }> = [];
  onmessage: ((e: MessageEvent<SpellResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;

  private readonly opts: FakeWorkerOptions;

  constructor(opts: FakeWorkerOptions = {}) {
    this.opts = opts;
  }

  postMessage(
    msg: SpellRequest,
    transfer?: Transferable[] | StructuredSerializeOptions,
  ): void {
    this.posted.push({
      msg,
      transfer: Array.isArray(transfer) ? transfer : [],
    });
    const reply = this.replyFor(msg);
    if (reply) void Promise.resolve().then(() => this.deliver(reply));
  }

  terminate(): void {
    this.terminated = true;
  }

  deliver(msg: SpellResponse): void {
    if (!this.terminated)
      this.onmessage?.({ data: msg } as MessageEvent<SpellResponse>);
  }

  of<T extends SpellRequest["type"]>(
    type: T,
  ): Array<Extract<SpellRequest, { type: T }>> {
    return this.posted
      .map((p) => p.msg)
      .filter((m): m is Extract<SpellRequest, { type: T }> => m.type === type);
  }

  private replyFor(msg: SpellRequest): SpellResponse | null {
    switch (msg.type) {
      case "init":
        return { type: "ready", id: msg.id };
      case "loadDictionary":
        if (this.opts.failDictionaries?.includes(msg.lang)) {
          return {
            type: "dictionaryError",
            id: msg.id,
            lang: msg.lang,
            message: "boom",
          };
        }
        return {
          type: "dictionaryLoaded",
          id: msg.id,
          lang: msg.lang,
          ms: 1,
          bytes: 1,
        };
      case "check":
        return {
          type: "checked",
          id: msg.id,
          docId: msg.docId,
          results:
            this.opts.onCheck?.(msg) ??
            msg.blocks.map((b) => ({
              blockId: b.blockId,
              version: b.version,
              flags: [],
            })),
        };
      case "suggest":
        return {
          type: "suggestions",
          id: msg.id,
          word: msg.word,
          suggestions: this.opts.onSuggest?.(msg) ?? [`${msg.word}s`],
        };
      default:
        return null;
    }
  }

  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

/** Let queued microtasks (fake-worker replies, awaited fetches) settle. */
export async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
