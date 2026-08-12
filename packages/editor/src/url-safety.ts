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
 * A reference into some other document rather than a destination of its own: a
 * path, a query, or a fragment. Tested only once `//` and a scheme have been
 * ruled out, so it does not have to spell those exclusions itself.
 */
const RELATIVE_REF = /^([/?#]|\.\.?\/)/;

/**
 * Resolve an untrusted link URL to an absolute one that is safe to open, or
 * `null` if its scheme isn't allowed (and for input that isn't a URL at all).
 * The returned string is the parsed, normalized form — use it in place of the
 * raw attribute; keep the raw one for display only.
 *
 * For the `href` sink use {@link safeLinkHref}, which keeps relative references
 * this refuses.
 */
export function normalizeLinkUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  // Browsers strip tabs and newlines from inside a URL before parsing, so a
  // "java\nscript:" spelling reaches them as a javascript: URL. Drop the whole
  // C0 range ahead of the scheme sniff, so the allowlist judges what the browser
  // would actually run rather than the obfuscated spelling.
  const cleaned = raw.replace(CONTROL_CHARS, "").trim();
  if (!cleaned) return null;

  let candidate: string;
  if (cleaned.startsWith("//")) {
    // Protocol-relative — an absolute URL missing only its scheme, which is https.
    candidate = `https:${cleaned}`;
  } else if (SCHEME_PREFIX.test(cleaned)) {
    // Already carries a scheme, so the allowlist — never a guessed prefix — decides.
    candidate = cleaned;
  } else if (RELATIVE_REF.test(cleaned)) {
    // `/docs/setup`, `./setup.md`, `#intro`: there is nothing here to resolve
    // them against, and guessing a scheme would invent a host
    // (`/docs/setup` → `https://docs/setup`) pointing at someone else's site.
    return null;
  } else {
    // A bare host, which is how authors type `example.com`.
    candidate = `https://${cleaned}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  return SAFE_LINK_PROTOCOLS.includes(url.protocol) ? url.href : null;
}

/**
 * Resolve an untrusted link URL for use as an `href`, or `null` if it may not
 * be emitted at all.
 *
 * Same allowlist as {@link normalizeLinkUrl}, but relative references survive
 * verbatim: an imported document's `/docs/setup` or `#intro` means a place in
 * that document's own site, and rewriting it to an absolute URL would point it
 * somewhere else entirely. They carry no scheme, so there is nothing to allow
 * or refuse — the caller still escapes the result into the attribute.
 */
export function safeLinkHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_CHARS, "").trim();
  if (!cleaned) return null;
  if (!cleaned.startsWith("//") && RELATIVE_REF.test(cleaned)) return cleaned;
  return normalizeLinkUrl(cleaned);
}

/** True when {@link normalizeLinkUrl} would accept `raw`. */
export function isSafeLinkUrl(raw: unknown): boolean {
  return normalizeLinkUrl(raw) !== null;
}
