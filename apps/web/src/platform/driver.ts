/**
 * Driver Interface
 *
 * The minimal contract each platform must implement.
 * Everything else (queries, snapshot logic, identity management)
 * lives in the shared Engine and is written ONCE.
 *
 * - Electron:  better-sqlite3 (via IPC) + node:fs
 * - Capacitor: @capacitor-community/sqlite + @capacitor/filesystem
 * - Web:       sql.js (WASM) + OPFS / Cache API
 */

// =============================================================================
// Database
// =============================================================================

export interface DbRow {
  [column: string]: unknown;
}

export interface DbRunResult {
  /** Number of rows affected */
  changes: number;
  /** Last inserted row ID (if applicable) */
  lastInsertRowId?: number;
}

export interface DbDriver {
  /** Execute a SELECT query and return rows */
  execute<T extends DbRow = DbRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;

  /** Execute an INSERT / UPDATE / DELETE statement */
  run(sql: string, params?: unknown[]): Promise<DbRunResult>;

  /** Execute a raw SQL statement (DDL, pragma, etc.) */
  exec(sql: string): Promise<void>;

  /** Run multiple statements inside a transaction */
  transaction<T>(fn: (db: DbDriver) => Promise<T>): Promise<T>;
}

// =============================================================================
// Filesystem
// =============================================================================

export interface FsDriver {
  /** Read a file as bytes. Returns null if not found. */
  read(path: string): Promise<Uint8Array | null>;

  /** Write bytes to a file, creating parent directories as needed. */
  write(path: string, data: Uint8Array): Promise<void>;

  /** Delete a file. No-op if it doesn't exist. */
  delete(path: string): Promise<void>;

  /** List filenames in a directory. Returns [] if directory doesn't exist. */
  list(dir: string): Promise<string[]>;

  /** Check if a path exists. */
  exists(path: string): Promise<boolean>;
}

// =============================================================================
// Crypto
// =============================================================================

export interface CryptoDriver {
  /** Generate an Ed25519 keypair, returned as hex strings. */
  generateKeypair(): Promise<{ publicKey: string; privateKey: string }>;

  /** Sign a message with the private key (hex). Returns signature as hex. */
  sign(privateKey: string, message: Uint8Array): Promise<string>;

  /** Verify a signature (hex) against a public key (hex). */
  verify(publicKey: string, signature: string, message: Uint8Array): Promise<boolean>;
}

// =============================================================================
// Network (P2P transport)
// =============================================================================

/**
 * A connection to a single remote peer.
 * The driver handles framing/encryption — callers send and receive raw bytes.
 */
export interface NetworkPeer {
  /** Remote peer's public key (hex) */
  remotePublicKey: string;

  /** Send a message to this peer */
  send(data: Uint8Array): void;

  /** Subscribe to messages from this peer */
  onMessage(cb: (data: Uint8Array) => void): () => void;

  /** Subscribe to this peer disconnecting */
  onClose(cb: () => void): () => void;

  /** Close the connection */
  close(): void;
}

/**
 * A swarm topic — represents participation in a discovery topic.
 * Peers that join the same topic will discover and connect to each other.
 */
export interface NetworkTopic {
  /** Fires when a new peer connects on this topic */
  onPeerJoin(cb: (peer: NetworkPeer) => void): () => void;

  /** Fires when a peer disconnects from this topic */
  onPeerLeave(cb: (publicKey: string) => void): () => void;

  /** Currently connected peers */
  getPeers(): NetworkPeer[];

  /** Leave this topic and disconnect from its peers */
  destroy(): Promise<void>;
}

/**
 * Network driver — raw P2P transport via WebRTC.
 *
 * Every platform (Electron, Web, Capacitor) uses the same WebRTC implementation.
 * A lightweight signaling relay brokers initial connections, then data flows
 * peer-to-peer over DataChannels. This means desktop can talk to web can talk
 * to mobile — no network fragmentation.
 *
 * The driver handles peer discovery and connections.
 * It knows nothing about CRDT ops, pages, or spaces — that's the engine's job.
 */
export interface NetworkDriver {
  /**
   * Set the local peer ID used for signaling.
   * Must be called before join(). Typically the device's public key.
   */
  setLocalId(id: string): void;

  /**
   * Register an encryption key for a topic.
   * All signaling and relay payloads on this topic will be encrypted
   * with AES-GCM using this key. Must be called before join().
   */
  registerTopicKey(topicHex: string, key: Uint8Array): void;

  /**
   * Remove a previously registered topic encryption key.
   */
  unregisterTopicKey(topicHex: string): void;

  /**
   * Join a discovery topic. Peers joining the same topic will find each other.
   * For replication: topic = SHA-256(sorted(pubKeyA, pubKeyB)) per peer pair.
   * For pairing: topic = random one-time hex.
   */
  join(topic: Uint8Array): Promise<NetworkTopic>;

  /** Shut down all connections and stop discovery */
  destroy(): Promise<void>;
}

// =============================================================================
// Combined Driver
// =============================================================================

export interface Driver {
  db: DbDriver;
  fs: FsDriver;
  crypto: CryptoDriver;
  network: NetworkDriver;

  /**
   * Base path for the cypher workspace.
   * e.g. "~/cypher-workspace/.cypher" on desktop,
   * or an app-scoped path on mobile.
   */
  basePath: string;
}
