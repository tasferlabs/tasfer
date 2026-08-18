/**
 * Cloudflare Worker — live (OTA) web-bundle update server.
 *
 * Serves the native apps' update checks and the bundle downloads that follow.
 * Routes:
 *
 *   POST /check              does this device have an update?
 *   GET  /bundles/<v>.zip    the whole bundle, from R2
 *   GET  /files/<sha256>     one file of a bundle, for delta updates
 *   POST /stats                        accepted and dropped, see below
 *   POST /channel                      refused, see below
 *
 * Publishing is not an endpoint. The release workflow writes bundles to R2 and
 * channel pointers to KV with the Cloudflare API directly, so this Worker has
 * no write path at all and needs no credential to protect.
 *
 * PRIVACY: every check carries a per-install `device_id`. Nothing here reads
 * it — there is one release for everyone, so no part of the response depends
 * on which device is asking — and nothing writes it: not to KV, not to logs,
 * not to analytics. `PrivacyInfo.xcprivacy` declares no collected data types
 * and the App Store answers match; recording the device id would silently make
 * both wrong.
 */

import type { Env } from "./env";
import { handleCheck } from "./check";

/**
 * `bundles/<major.minor.patch>.zip` — nothing else is addressable.
 *
 * One copy per version, not one per platform: the web build is identical on
 * iOS and Android, and per-platform control already lives in the channel
 * pointer, which names a version per platform. Shipped apps only ever learn
 * this path from a `/check` response, so the layout stays ours to change.
 */
const BUNDLE_ROUTE = /^\/bundles\/(\d+\.\d+\.\d+)\.zip$/;

/**
 * `files/<sha256>` — content-addressed, so a file shared by five versions is
 * stored and downloaded once, and the device's own cache hits across releases.
 * The 64-hex shape is enforced here rather than trusted: the path segment is
 * used verbatim as an R2 key.
 */
const FILE_ROUTE = /^\/files\/([a-f0-9]{64})$/;

function objectHeaders(object: R2Object, contentType: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // Prefer what was stored. Bundle files are content-addressed, so the URL has
  // no extension to infer a type from, and the stored type is what lets
  // Cloudflare compress JS and CSS in transit — worth several times the
  // transfer on a delta update.
  if (!headers.get("content-type")) headers.set("content-type", contentType);
  // Everything served here is immutable: a version names one set of bytes, and
  // a file key IS its own hash. Safe to cache forever, at the edge and on the
  // device.
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return headers;
}

async function serveObject(
  env: Env,
  key: string,
  contentType: string,
  method: string,
): Promise<Response> {
  if (method === "HEAD") {
    const head = await env.BUNDLES.head(key);
    if (!head) return new Response(null, { status: 404 });
    return new Response(null, { headers: objectHeaders(head, contentType) });
  }

  const object = await env.BUNDLES.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, { headers: objectHeaders(object, contentType) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleCheck(request, env);
    }

    // Update statistics. Accepted so the plugin's reporting succeeds, and
    // discarded: the only thing worth knowing from it is adoption, and it is
    // not worth keeping a per-install identifier around to learn it. This
    // endpoint exists chiefly so `statsUrl` has somewhere of ours to point —
    // its default is Capgo's cloud.
    if (url.pathname === "/stats") {
      return new Response(null, { status: 204 });
    }

    // There are no channels — one release goes to everyone. This still has to
    // answer, rather than `channelUrl` being left unset, because its default is
    // Capgo's cloud and an unset value would send our app and device ids there.
    if (url.pathname === "/channel") {
      return Response.json({ error: "channel_not_supported" }, { status: 501 });
    }

    const bundle = BUNDLE_ROUTE.exec(url.pathname);
    const file = bundle ? null : FILE_ROUTE.exec(url.pathname);
    if (bundle || file) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      return bundle
        ? serveObject(env, `bundles/${bundle[1]}.zip`, "application/zip", request.method)
        : serveObject(env, `files/${file![1]}`, "application/octet-stream", request.method);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
