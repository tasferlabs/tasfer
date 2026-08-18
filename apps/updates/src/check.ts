/**
 * The update check.
 *
 * `@capgo/capacitor-updater` POSTs here every time the app comes to the
 * foreground. The response either names a bundle to download or says there is
 * nothing to do; the plugin does the rest.
 *
 * The server decides, not the client. It only ever answers with a bundle that
 * is strictly newer than what the device is running AND compatible with the
 * native shell the device actually has installed, so a device can never talk
 * itself into a bundle its binary cannot run.
 *
 * There is one release for everyone. No channels, no staged rollout, no
 * per-platform split — publishing is the decision, and the only dial is which
 * version the pointer names.
 */

import type { Env, ManifestEntry, Release } from "./env";
import { compareVersions, parseVersion } from "./semver";

/**
 * What the plugin sends. Every field is optional here because this is
 * unauthenticated input off the public internet — the shape is checked, never
 * assumed. `device_id` is deliberately not read: nothing about the response
 * depends on which device is asking.
 */
interface CheckRequest {
  app_id?: string;
  /**
   * The version of the bundle currently running. Equals `version_build` on a
   * fresh install (the built-in bundle reports the configured version), and
   * the applied bundle's version after an update has landed.
   */
  version_name?: string;
  /**
   * The built-in bundle's version — frozen inside the binary at build time and
   * unchanged by any update. This, not `version_name`, identifies which store
   * build the device is on.
   */
  version_build?: string;
}

/** The plugin treats any response carrying `message` as "nothing to do". */
function noUpdate(message: string, version: string | undefined): Response {
  return Response.json({ message, version: version ?? "" });
}

export async function handleCheck(request: Request, env: Env): Promise<Response> {
  let body: CheckRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: "Malformed request body", version: "" }, { status: 400 });
  }

  if (body.app_id !== env.APP_ID) {
    return Response.json({ message: "Unknown app", version: "" }, { status: 404 });
  }

  const release = await env.RELEASES.get<Release>("release", "json");
  if (!release) {
    return noUpdate("No bundle published", body.version_name);
  }

  const candidate = parseVersion(release.version);
  if (!candidate) {
    // Our own pipeline wrote this, so it is a bug on our side, not the
    // device's. Fail closed and leave the app on what it has.
    return noUpdate("Published bundle has an unusable version", body.version_name);
  }

  // Compatibility, against the built-in version rather than the running one:
  // an old shell that has already taken a few OTA bundles still cannot run a
  // bundle needing native code it never shipped with.
  const builtin = parseVersion(body.version_build);
  const minBuiltin = parseVersion(release.minBuiltin);
  if (minBuiltin && (!builtin || compareVersions(builtin, minBuiltin) < 0)) {
    return noUpdate("Bundle requires a newer app version", body.version_name);
  }

  // Is it actually newer? Prefer the running bundle's version; fall back to the
  // built-in one when the device reports a placeholder instead of a version,
  // which the plugin does before it has any bundle metadata.
  const baseline = parseVersion(body.version_name) ?? builtin;
  if (baseline && compareVersions(candidate, baseline) <= 0) {
    return noUpdate("Already up to date", body.version_name);
  }

  // Delta update: with a manifest the plugin fetches only the files it does not
  // already have — from the built-in bundle, from its cache of previous
  // bundles, and only then over the network.
  //
  // `url` is still sent alongside. The plugin prefers the manifest when one is
  // present, and a missing manifest — an older publish, or a KV read that came
  // back empty — degrades to downloading the whole zip rather than failing.
  const manifest = await env.RELEASES.get<ManifestEntry[]>(`manifest:${release.version}`, "json");

  return Response.json({
    version: release.version,
    url: `${env.PUBLIC_ORIGIN}/bundles/${release.version}.zip`,
    checksum: release.checksum,
    // Emitted under both spellings on purpose: the Android side reads
    // `session_key` verbatim, and the iOS payload types use `sessionKey`.
    // Sending one and hoping is how an encrypted bundle silently fails to
    // decrypt on one platform only.
    ...(release.sessionKey
      ? { session_key: release.sessionKey, sessionKey: release.sessionKey }
      : {}),
    ...(manifest?.length
      ? {
          manifest: manifest.map((entry) => ({
            ...entry,
            download_url: `${env.PUBLIC_ORIGIN}/files/${entry.file_hash}`,
          })),
        }
      : {}),
  });
}
