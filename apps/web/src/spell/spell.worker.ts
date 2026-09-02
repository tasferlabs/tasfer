/// <reference lib="webworker" />
/**
 * The spell worker. One per app (started lazily by SpellService); the host
 * from @tasfer/spell owns engines and routing, this file only wires the
 * Hunspell factory to the wasm bytes the main thread sends in `init` — the
 * worker never fetches anything itself (Electron's file:// renderer and the
 * Capacitor origin only resolve public assets from the main thread).
 */
import type {
  CreateEngineOptions,
  SpellEngineFactory,
  SpellRequest,
  SpellResponse,
} from "@tasfer/spell";
import { createHunspellFactory } from "@tasfer/spell/hunspell";
import { createWorkerHost } from "@tasfer/spell/worker";

let factory: SpellEngineFactory | null = null;

const lazyFactory: SpellEngineFactory = {
  create(opts: CreateEngineOptions) {
    if (!factory)
      return Promise.reject(new Error("spell worker not initialised"));
    return factory.create(opts);
  },
};

const host = createWorkerHost(
  (msg: SpellResponse, transfer?: Transferable[]) =>
    self.postMessage(msg, transfer ?? []),
  lazyFactory,
);

self.onmessage = (e: MessageEvent<SpellRequest>) => {
  if (e.data.type === "init")
    factory = createHunspellFactory({ wasm: e.data.wasm });
  void host(e.data);
};
