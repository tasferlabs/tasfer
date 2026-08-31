import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWebRtcNetworkDriver } from "@/platform/adapters/webrtc";

/**
 * Node's global WebSocket (undici) does not fire a close event when close() is
 * called on a socket that is still CONNECTING: it emits `error`, leaves the
 * socket in CLOSING, and never runs onclose. This fake reproduces that exactly,
 * because it is what the CLI host runs on — a browser socket would have closed.
 */
class NeverConnectingSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: NeverConnectingSocket[] = [];

  readyState = NeverConnectingSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number; wasClean: boolean; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    NeverConnectingSocket.instances.push(this);
  }

  close(): void {
    if (this.readyState !== NeverConnectingSocket.CONNECTING) return;
    // Precisely undici: park in CLOSING, emit error, never emit close.
    this.readyState = NeverConnectingSocket.CLOSING;
    this.onerror?.();
  }

  send(): void {}
}

const TOPIC = "a".repeat(64);

/**
 * Drain pending microtasks and event-loop turns (fake timers aside). Several
 * turns, because key derivation hops through the crypto threadpool.
 */
const flush = async (turns = 10) => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe("WebRtcTopic signaling reconnect", () => {
  const realWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    NeverConnectingSocket.instances = [];
    vi.stubGlobal("WebSocket", NeverConnectingSocket);
    // Leave setImmediate real so `flush()` can yield to WebCrypto, which
    // resolves on the event loop rather than on a timer.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.stubGlobal("WebSocket", realWebSocket);
    vi.unstubAllGlobals();
  });

  it("keeps retrying after a connect that times out without a close event", async () => {
    const driver = createWebRtcNetworkDriver("wss://signaling.example", { relayOnly: true });
    driver.setLocalId("peer-local");
    driver.registerTopicKey(TOPIC, new Uint8Array(32).fill(7));

    const joined = driver.join(Uint8Array.from({ length: 32 }, () => 0xaa));

    // Let deriveAesKey (a real WebCrypto call) settle before the socket exists.
    await flush();
    expect(NeverConnectingSocket.instances).toHaveLength(1);

    // Cross the 12s connect deadline: the driver closes the socket, and undici
    // answers with `error` only. join() must not hang on that.
    await vi.advanceTimersByTimeAsync(12_000);
    await flush();
    await expect(joined).resolves.toBeDefined();

    // First backoff step is 1s. Without a synthesized teardown, no second
    // socket is ever built and the topic is dead for the life of the process.
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(NeverConnectingSocket.instances).toHaveLength(2);

    // And the backoff keeps going: 2s, then 4s, each after its own timeout.
    await vi.advanceTimersByTimeAsync(12_000 + 2_000);
    await flush();
    expect(NeverConnectingSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(12_000 + 4_000);
    await flush();
    expect(NeverConnectingSocket.instances).toHaveLength(4);
  });
});
