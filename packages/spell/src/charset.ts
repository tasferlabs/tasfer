/**
 * Legacy dictionary charsets.
 *
 * Hunspell dictionaries predate UTF-8 being universal and declare their
 * encoding in the `.aff`'s `SET` line. Both the engine adapter (which
 * transcodes before loading) and hosts that inspect a file the person picked
 * (its language, its script) need to read that line the same way, so the
 * mapping lives here rather than beside either of them.
 */

/** The `.aff` line that names the file's charset, e.g. `SET ISO8859-6`. */
export const AFF_SET_LINE_RE = /^[ \t]*SET[ \t]+(\S+)[^\r\n]*/m;

/**
 * Hunspell's `SET` value → a `TextDecoder` label. Hunspell names follow the
 * `ISO8859-N`, `microsoft-cp125N` conventions; WHATWG wants `iso-8859-N`,
 * `windows-125N`.
 */
export function charsetLabel(hunspellCharset: string): string {
  const cs = hunspellCharset.trim().toLowerCase();
  if (cs === "utf-8" || cs === "utf8") return "utf-8";
  if (cs === "iso8859-1" || cs === "iso-8859-1" || cs === "latin1")
    return "latin1";
  const iso = /^iso-?8859-(\d{1,2})$/.exec(cs);
  if (iso) return `iso-8859-${iso[1]}`;
  const cp = /^(?:microsoft-)?cp(\d{3,4})$/.exec(cs);
  if (cp) return `windows-${cp[1]}`;
  const win = /^windows-?(\d{3,4})$/.exec(cs);
  if (win) return `windows-${win[1]}`;
  if (cs === "tis620-2533" || cs === "tis-620") return "windows-874";
  return cs; // koi8-r, koi8-u, … are already valid labels
}

/** A decoder for `label`, falling back to UTF-8 for encodings the runtime lacks. */
export function decoderFor(label: string): TextDecoder {
  try {
    return new TextDecoder(label);
  } catch {
    // Unknown encoding (e.g. ISCII-DEVANAGARI): best effort as UTF-8.
    return new TextDecoder("utf-8");
  }
}

/**
 * The charset an affix file declares, as a `TextDecoder` label. Only the head
 * is examined: the directive is ASCII in every encoding Hunspell supports, so
 * a latin1 view of the first bytes is enough to find it.
 */
export function declaredCharset(affBytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(
    affBytes.subarray(0, Math.min(affBytes.length, 65536)),
  );
  return charsetLabel(AFF_SET_LINE_RE.exec(head)?.[1] ?? "UTF-8");
}
