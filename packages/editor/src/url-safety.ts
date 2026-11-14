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
 * Turn an untrusted link URL into an absolute URL that is safe to open. A bare
 * host such as `example.com` becomes `https://example.com/`.
 *
 * Returns `null` when the scheme is not allowed (see
 * {@link SAFE_LINK_PROTOCOLS}), for a relative link such as `/docs` or
 * `#intro`, and for anything that is not a URL. Open the returned string, not
 * the raw one. Keep the raw one only for display.
 *
 * For an `href`, use {@link safeLinkHref}. It keeps relative links.
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
 * Make an untrusted link URL safe to use as an `href`. Returns `null` when it
 * may not be used at all.
 *
 * It allows the same schemes as {@link normalizeLinkUrl}. Unlike that one, it
 * keeps relative links such as `/docs/setup` or `#intro` as they are, because
 * they point into the document's own site. You still need to escape the result
 * when you write it into an attribute.
 */
// Rewriting a relative reference to an absolute URL would point it somewhere
// else entirely. Relative refs carry no scheme, so there is nothing to allow or
// refuse.
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

/**
 * Schemes the browser hands to whichever app claims them. They never navigate
 * the document that asked, so aiming one at a new tab strands an empty tab
 * behind the handoff.
 */
const HANDOFF_PROTOCOLS: readonly string[] = ["mailto:", "tel:"];

/**
 * Open a link the way a click on `<a target="_blank">` would: in a new tab,
 * with no opener and no referrer. `mailto:` and `tel:` links go to the app that
 * handles them, with no new tab. The URL goes through {@link normalizeLinkUrl}
 * first. Returns `false`, and opens nothing, when that refuses it.
 *
 * Call it inside the click or key handler that asked for it, so the browser
 * treats it as the user's own action.
 */
// window.open(url, "_blank", "noopener,noreferrer") is the obvious spelling and
// the wrong one. Per HTML's "popup window is requested" steps, any non-empty
// feature string that leaves out location/toolbar asks for a popup window
// rather than a tab. A popup is what an embedded browser window is most willing
// to refuse, and a refused popup looks like a dead link. An anchor click asks
// for no window and severs opener and referrer through rel instead. User
// activation lives on the window, so the synthetic click inherits the real one.
export function openLinkUrl(raw: unknown): boolean {
  const url = normalizeLinkUrl(raw);
  if (!url) return false;

  const anchor = document.createElement("a");
  anchor.href = url;
  if (!HANDOFF_PROTOCOLS.includes(new URL(url).protocol)) {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  anchor.style.display = "none";
  // Connected to the document, because a click on a detached anchor is not
  // guaranteed to navigate.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}
