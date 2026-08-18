export interface Env {
  /**
   * Published artifacts:
   *   `bundles/<version>.zip`  the whole bundle
   *   `files/<sha256>`         one object per distinct file, shared by every
   *                            version that contains it
   *   `meta/<version>.json`    what a later re-point needs to reproduce a release
   */
  BUNDLES: R2Bucket;
  /**
   * The current release (`release`, see `Release`) and per-version file
   * manifests (`manifest:<version>`, see `ManifestEntry`).
   *
   * Separate keys on purpose: the release pointer is rewritten on every publish,
   * so its edge cache is short-lived, while a manifest is immutable once written
   * and stays hot.
   */
  RELEASES: KVNamespace;
  /** The only app id this server answers for. */
  APP_ID: string;
  /** Origin bundle and file download URLs are built from. */
  PUBLIC_ORIGIN: string;
}

/**
 * The bundle every device is currently offered.
 *
 * One release, for both platforms — the web build is byte-identical on iOS and
 * Android. Written by the release workflow, read on every update check. Nothing
 * here is secret; the same values go to any device that asks.
 */
export interface Release {
  /**
   * Bundle version. Plain `X.Y.Z`, strictly increasing across every publish,
   * store releases included. No prerelease or build-metadata suffixes: semver
   * ranks `1.2.3-x` BELOW `1.2.3` and ignores `+x` entirely, so either would
   * read as a downgrade to a device already on `1.2.3`.
   */
  version: string;
  /**
   * The oldest built-in bundle version this bundle runs on — that is, the
   * oldest store build. A device reports its built-in version as
   * `version_build`, which is frozen at whatever shipped inside the binary and
   * never moves, so it is the only reliable marker of which native shell the
   * device is actually running.
   *
   * This is what stops a bundle that needs a newer native capability from
   * reaching a shell that lacks it. Raise it in `version.json` in the same
   * change that adds the native dependency.
   */
  minBuiltin: string;
  /**
   * SHA-256 of the zip, hex. The plugin refuses a bundle that does not match.
   * For an encrypted bundle this is the encrypted checksum that
   * `capgo bundle encrypt` returns, not the plain zip's digest.
   */
  checksum: string;
  /** `ivSessionKey` from `capgo bundle encrypt`. Absent for plain bundles. */
  sessionKey?: string;
}

/**
 * One file in a bundle, as stored under `manifest:<version>`.
 *
 * `download_url` is added by the server at response time rather than stored, so
 * the published artifact never bakes in an origin.
 */
export interface ManifestEntry {
  /**
   * Path relative to the bundle root, e.g. `vc-ap-17c611/index-abc123.js`.
   *
   * It must match the path inside the app's own `public/` folder exactly: the
   * plugin checks the built-in bundle for a file with this name and the right
   * hash before it downloads anything, which is where most of the saving comes
   * from on an app that has just been installed from the store. (This is also
   * why files are not published brotli-compressed under a `.br` name — the
   * plugin would then look for `<name>.br` in the built-in bundle, find
   * nothing, and download every file.)
   */
  file_name: string;
  /** Lowercase hex SHA-256 of the file's bytes, verified on device. */
  file_hash: string;
}
