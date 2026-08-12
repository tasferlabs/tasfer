/**
 * Link URL safety — the one protocol allowlist every sink that opens or renders
 * a document-supplied URL runs through.
 *
 * A link mark's `attrs.url` is untrusted: it arrives from markdown import, from
 * a paste, or over CRDT sync from a peer, and nothing on that path inspects it.
 * `javascript:` and `data:` URLs execute in the app's own origin, and arbitrary
 * custom schemes let a shared document drive other apps on the device — so the
 * scheme is decided here, once, rather than at each call site.
 *
 * Host-side confirmation (asking the user before leaving the app) sits on top of
 * this; the engine only answers "may this URL be used at all".
 */

/** Schemes a link may point at. Everything else is refused. */
export const SAFE_LINK_PROTOCOLS: readonly string[] = Object.freeze([
  "http:",
  "https:",
  "mailto:",
  "tel:",
]);

/** RFC 3986 scheme prefix — tells "has a scheme" from "bare host". */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/** C0 controls + DEL, which browsers strip or reject inside a URL. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Resolve an untrusted link URL to one that is safe to open or emit as an
 * `href`, or `null` if its scheme isn't allowed (and for input that isn't a URL
 * at all). The returned string is the parsed, normalized form — use it in place
 * of the raw attribute; keep the raw one for display only.
 */
export function normalizeLinkUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  // Browsers strip tabs and newlines from inside a URL before parsing, so a
  // "java\nscript:" spelling reaches them as a javascript: URL. Drop the whole
  // C0 range ahead of the scheme sniff, so the allowlist judges what the browser
  // would actually run rather than the obfuscated spelling.
  const cleaned = raw.replace(CONTROL_CHARS, "").trim();
  if (!cleaned) return null;

  // Authors type bare hosts (`example.com`) and protocol-relative URLs
  // (`//example.com`); both mean https. Anything that already carries a scheme
  // is parsed as written, so the allowlist — never a guessed prefix — decides.
  const candidate = cleaned.startsWith("//")
    ? `https:${cleaned}`
    : SCHEME_PREFIX.test(cleaned)
      ? cleaned
      : `https://${cleaned}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  return SAFE_LINK_PROTOCOLS.includes(url.protocol) ? url.href : null;
}

/** True when {@link normalizeLinkUrl} would accept `raw`. */
export function isSafeLinkUrl(raw: unknown): boolean {
  return normalizeLinkUrl(raw) !== null;
}
