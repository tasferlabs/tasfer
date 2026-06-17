/**
 * Error types thrown by `@cypherkit/editor`.
 *
 * One home for the package's error *concept*: every error the editor throws
 * extends {@link EditorError}, so a host can `catch (e) { if (e instanceof
 * EditorError) … }` to handle anything editor-originated, then narrow with
 * `instanceof` for a specific case. Keep new error types here rather than
 * scattering `class … extends Error` through the modules that throw them.
 */

/**
 * Base class for every error thrown by `@cypherkit/editor`. Catch this to
 * handle any editor-originated failure generically; use a subclass for the
 * specific cases below.
 */
export class EditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorError";
  }
}

/**
 * Thrown by `createDoc(bytes)` when the persisted blob isn't a format this
 * build can read — typically because it was written by a *newer* app version.
 * Distinct and catchable (not an anonymous `Error`) so a host can tell
 * "document from a newer version, prompt to update" apart from a genuine bug,
 * and degrade gracefully instead of crashing.
 *
 * - `version` — the blob's declared format version, or `undefined` if it was
 *   missing/malformed.
 * - `supportedVersion` — the format version this build reads.
 */
export class IncompatibleDocVersionError extends EditorError {
  readonly version: number | undefined;
  readonly supportedVersion: number;
  constructor(version: number | undefined, supportedVersion: number) {
    super(
      version === undefined
        ? "Cannot read persisted document: missing or malformed version field"
        : `Cannot read persisted document: unsupported format version ${version} ` +
            `(this build reads v${supportedVersion})`,
    );
    this.name = "IncompatibleDocVersionError";
    this.version = version;
    this.supportedVersion = supportedVersion;
  }
}
