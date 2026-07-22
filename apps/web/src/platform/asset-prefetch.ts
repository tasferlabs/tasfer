/**
 * AssetPrefetcher — eager pull of content-addressed assets from peers.
 *
 * Documents replicate eagerly, but assets used to be fetched only when an
 * image actually rendered (assets.getUrl → replicator.requestAsset). A page
 * could therefore arrive on a device long before its images did — and if the
 * peer holding them went offline in between, opening the page later showed
 * nothing. This module makes asset transfer as eager as op replication while
 * staying receiver-driven: whenever the engine learns of asset references
 * (remote page ops, avatar updates, the startup sweep), the hashes missing
 * from the local store are queued and pulled over the existing
 * asset-req/asset-data protocol.
 *
 * No wire change: peers already serve any asset they hold from disk, and we
 * only ask for hashes learned from our own replicated data — the same access
 * model as the on-demand path, so nothing new is exposed across spaces.
 */

export interface AssetPrefetchHost {
  /** Hashes of every asset present in the local store. */
  listLocalAssetHashes(): Promise<Set<string>>;
  /** Pull one asset from connected peers. Resolves false if none had it. */
  requestAsset(hash: string): Promise<boolean>;
}

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Extract a content hash from a block asset ref. Refs can be a raw sha256
 * hash (current) or a legacy `/api/images/<hash>` URL; external sources
 * (http/blob/data URLs) are not assets and yield null.
 */
export function assetHashFromRef(ref: string): string | null {
  const raw = ref.startsWith("/api/images/")
    ? ref.slice("/api/images/".length).split(/[/?#]/, 1)[0]
    : ref;
  const hash = raw.toLowerCase();
  return HASH_RE.test(hash) ? hash : null;
}

export class AssetPrefetcher {
  private host: AssetPrefetchHost;
  /** Hashes referenced by replicated data but absent from the local store. */
  private wanted = new Set<string>();
  /**
   * Hashes already requested since the last peer change. A request that found
   * no holder stays in `wanted` but is not re-sent to the same peer set;
   * retry() clears this when a peer (re)connects.
   */
  private attempted = new Set<string>();
  private draining = false;

  constructor(host: AssetPrefetchHost) {
    this.host = host;
  }

  /** Queue whichever refs are content hashes missing locally, then pull them. */
  noteRefs(refs: string[]): void {
    const hashes: string[] = [];
    for (const ref of refs) {
      const hash = assetHashFromRef(ref);
      if (hash) hashes.push(hash);
    }
    if (hashes.length === 0) return;
    void this.enqueueMissing(hashes).catch((e) => {
      console.warn("[AssetPrefetch] enqueue failed:", e);
    });
  }

  /** Re-request everything still missing — call when a peer becomes ready. */
  retry(): void {
    this.attempted.clear();
    void this.drain();
  }

  private async enqueueMissing(hashes: string[]): Promise<void> {
    const local = await this.host.listLocalAssetHashes();
    let added = false;
    for (const hash of hashes) {
      if (local.has(hash) || this.wanted.has(hash)) continue;
      this.wanted.add(hash);
      added = true;
    }
    if (added) void this.drain();
  }

  /**
   * Pull queued assets one at a time. Sequential on purpose: asset frames
   * share the DataChannel with op replication and awareness, and parallel
   * multi-MB transfers would starve those.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const next = [...this.wanted].find((h) => !this.attempted.has(h));
        if (!next) return;
        this.attempted.add(next);
        const found = await this.host.requestAsset(next).catch(() => false);
        if (found) this.wanted.delete(next);
      }
    } finally {
      this.draining = false;
    }
  }
}
