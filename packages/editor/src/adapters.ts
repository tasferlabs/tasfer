/**
 * Host adapters.
 *
 * The headless editor core is platform-agnostic. Anything that needs to reach
 * outside the editor (resolving content-addressed asset URLs, etc.) is routed
 * through an injectable adapter so the package has no hard dependency on the
 * host application's platform layer.
 *
 * Hosts call the `set*` functions once at startup. Defaults are safe no-ops so
 * the editor works standalone without any host wiring.
 */

/** Resolve a (possibly content-addressed) asset URL to a loadable URL. */
export type AssetResolver = (url: string) => Promise<string>;

let assetResolver: AssetResolver = async (url) => url;

/** Inject the host's asset URL resolver (e.g. platform.assets.getUrl). */
export function setAssetResolver(resolver: AssetResolver): void {
  assetResolver = resolver;
}

/** Resolve an asset URL via the host-provided resolver (identity by default). */
export function resolveAssetUrl(url: string): Promise<string> {
  return assetResolver(url);
}

//NOTE - URL and images logic be up to the consumer by making the block extensible and allowing them to define their own blocks.
