/**
 * Platform RPC protocol — wire contract between a tab (client) and the
 * `Engine` (server), spoken over a `MessagePort`-shaped channel.
 *
 * This is the seam that lets the `Engine` move out of the tab and into the
 * SharedWorker (Phase 2). In Phase 1 the same protocol runs over an in-tab
 * `MessageChannel`, so the full serialization path is exercised without yet
 * relocating anything — purely to validate that every `Platform` method
 * survives `structuredClone` and that callbacks/subscriptions round-trip.
 *
 * The `Platform` interface has six method *shapes*; each is handled uniformly
 * by reading {@link PLATFORM_SCHEMA} rather than hand-writing every method:
 *
 *   - `request`         — async request/response (the default)
 *   - `fire`            — fire-and-forget, no reply (e.g. sendOperations)
 *   - `getter`          — synchronous return, served from a tab-local mirror
 *                         kept fresh by an internal subscription
 *   - `subscribe`       — last arg is a single callback; returns an unsubscribe
 *   - `subscribeObject` — arg is an object of named callbacks; returns unsub
 *   - `callbackMethod`  — async, but one arg is an object of named callbacks
 *                         that must be proxied back to the caller (joinRoom,
 *                         pairing)
 */

// =============================================================================
// Transport
// =============================================================================

/**
 * The minimal shape shared by `MessagePort`, a dedicated `Worker`, and a
 * `SharedWorker`'s port. The RPC layer is agnostic to which backs it.
 */
export interface RpcPort {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
  start?(): void;
}

// =============================================================================
// Messages
// =============================================================================

export type RpcCallId = number;
export type RpcSubId = number;
export type RpcCbHandle = number;

/** client → server: invoke a `request` / `callbackMethod`, expect a `return`. */
export interface CallMsg {
  t: "call";
  id: RpcCallId;
  ns: string;
  method: string;
  args: unknown[];
  /** callbackMethod only: handle the server posts `cb` messages against. */
  cbHandle?: RpcCbHandle;
  /** callbackMethod only: the callback keys the caller actually provided. */
  cbKeys?: string[];
}

/** server → client: result of a `call`. */
export interface ReturnMsg {
  t: "return";
  id: RpcCallId;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** client → server: a `fire` method — no reply. */
export interface FireMsg {
  t: "fire";
  ns: string;
  method: string;
  args: unknown[];
}

/** client → server: open a subscription. */
export interface SubscribeMsg {
  t: "sub";
  subId: RpcSubId;
  ns: string;
  method: string;
  /** subscribeObject only: the callback keys the caller provided. */
  cbKeys?: string[];
}

/** client → server: close a subscription. */
export interface UnsubscribeMsg {
  t: "unsub";
  subId: RpcSubId;
}

/** server → client: a subscription fired. `key` is set for object subs. */
export interface EventMsg {
  t: "event";
  subId: RpcSubId;
  key?: string;
  args: unknown[];
}

/** server → client: a proxied callback (from a callbackMethod) fired. */
export interface CallbackMsg {
  t: "cb";
  handle: RpcCbHandle;
  key: string;
  args: unknown[];
}

/** client → server: drop a callbackMethod's handle (caller is done with it). */
export interface ReleaseCbMsg {
  t: "releaseCb";
  handle: RpcCbHandle;
}

/**
 * client → server: this connection is going away (tab closing). Lets the server
 * tear down the connection's subscriptions and room membership promptly, since
 * a `SharedWorker` port has no reliable close event. Best-effort, sent on
 * `pagehide`.
 */
export interface CloseMsg {
  t: "close";
}

/**
 * client → server: this tab won the `tasfer-net` lock and is now the transport
 * host. The transferred `MessagePort` (in the message's transfer list) speaks
 * the network RPC protocol; the worker's NetworkProxy drives WebRTC through it.
 */
export interface NetHostMsg {
  t: "netHost";
}

export type ClientToServer =
  | CallMsg
  | FireMsg
  | SubscribeMsg
  | UnsubscribeMsg
  | ReleaseCbMsg
  | CloseMsg
  | NetHostMsg;

export type ServerToClient = ReturnMsg | EventMsg | CallbackMsg;

export type RpcMessage = ClientToServer | ServerToClient;

/**
 * Built-in method (outside the `Platform` surface) the client calls once on
 * connect to seed its synchronous-getter mirrors. Keeps user subscriptions
 * behaving exactly like the in-process engine (no surprise initial fire).
 */
export const RPC_INITIAL_STATE = { ns: "__rpc", method: "initialState" } as const;

export interface InitialState {
  connectionState: unknown;
  connectedPeers: unknown;
}

// =============================================================================
// Method schema
// =============================================================================

export type MethodKind =
  | "request"
  | "fire"
  | "getter"
  | "subscribe"
  | "subscribeObject"
  | "callbackMethod";

export interface MethodDesc {
  kind: MethodKind;
  /** Index of the callback / callbacks-object argument. */
  cbArg?: number;
}

/**
 * Declarative description of every `Platform` method. The client and server
 * both drive off this map, so the two stay in lock-step and adding a method is
 * a one-line change here.
 */
export const PLATFORM_SCHEMA: Record<string, Record<string, MethodDesc>> = {
  identity: {
    get: { kind: "request" },
    update: { kind: "request" },
  },
  peers: {
    list: { kind: "request" },
    trust: { kind: "request" },
    untrust: { kind: "request" },
    remove: { kind: "request" },
  },
  spaces: {
    list: { kind: "request" },
    listArchived: { kind: "request" },
    get: { kind: "request" },
    create: { kind: "request" },
    rename: { kind: "request" },
    archive: { kind: "request" },
    unarchive: { kind: "request" },
    updateMember: { kind: "request" },
    onChange: { kind: "subscribe", cbArg: 0 },
  },
  pairing: {
    createInvite: { kind: "request" },
    waitForPeer: { kind: "callbackMethod", cbArg: 1 },
    acceptInvite: { kind: "callbackMethod", cbArg: 1 },
    cancel: { kind: "request" },
  },
  pages: {
    list: { kind: "request" },
    get: { kind: "request" },
    create: { kind: "request" },
    update: { kind: "request" },
    delete: { kind: "request" },
    listArchived: { kind: "request" },
    restore: { kind: "request" },
    move: { kind: "request" },
    subtree: { kind: "request" },
    recreateInSpace: { kind: "request" },
    reorder: { kind: "request" },
    search: { kind: "request" },
    calendar: { kind: "request" },
    snapshots: { kind: "request" },
    onDeleted: { kind: "subscribe", cbArg: 0 },
  },
  assets: {
    store: { kind: "request" },
    // getUrl is NOT served generically: a blob: URL minted in the worker is
    // dead in the tab DOM. The client overrides it to fetch `getBytes` and mint
    // a tab-local blob URL. getBytes is the context-free byte fetch it calls.
    getBytes: { kind: "request" },
    delete: { kind: "request" },
  },
  sync: {
    joinRoom: { kind: "callbackMethod", cbArg: 3 },
    leaveRoom: { kind: "request" },
    sendOperations: { kind: "fire" },
    sendSyncRequest: { kind: "fire" },
    sendSyncResponse: { kind: "fire" },
    sendAwareness: { kind: "fire" },
    onPageEvents: { kind: "subscribeObject", cbArg: 0 },
    getConnectionState: { kind: "getter" },
    onConnectionChange: { kind: "subscribe", cbArg: 0 },
    getConnectedPeers: { kind: "getter" },
    onConnectedPeersChange: { kind: "subscribe", cbArg: 0 },
    onPeerVersionMismatch: { kind: "subscribe", cbArg: 0 },
  },
  ops: {
    persist: { kind: "request" },
    load: { kind: "request" },
    writeBlocks: { kind: "request" },
  },
  snapshots: {
    save: { kind: "request" },
  },
  db: {
    query: { kind: "request" },
    mutate: { kind: "request" },
    exec: { kind: "request" },
    getPendingMigrations: { kind: "request" },
    applyMigrations: { kind: "request" },
  },
};
