/**
 * Generates the social share cards at public/og.png and public/og.ar.png
 * (1200×630, the OpenGraph / Twitter summary_large_image size). Run after
 * changing the promise copy, the brand accent, or the logo:
 *
 *   node scripts/generate-og.mjs
 *
 * The cards are built as SVG and rasterized with sharp. The faces are embedded
 * as base64 @font-face so the type renders identically regardless of which
 * fonts the build machine has installed — librsvg resolves the embedded face
 * rather than falling back to a system font. Poppins carries the Latin card;
 * Noto Sans Arabic carries the Arabic one, matching --font-ui on the site.
 *
 * The copy is read from src/lib/i18n/<lng>.json rather than hardcoded, so the
 * card can't drift from the site's translation store. The wordmark comes from
 * `brand.wordmark`: "tasfer" in English, "تصفير" in Arabic.
 *
 * RTL rendering notes (both learned the hard way against librsvg):
 *   - Do NOT set direction="rtl". librsvg already applies bidi ordering and
 *     Arabic shaping to the raw string; adding the attribute makes the run lay
 *     out leftward from `x` and disappear off the canvas.
 *   - Right-align with text-anchor="end" and an `x` at the right margin. That
 *     is honored, and is the only alignment mechanism that works here.
 *   - Because `direction` is unusable, librsvg resolves each run with an LTR
 *     base direction. A single Arabic phrase survives that, but a string mixing
 *     scripts or spanning several sentences comes out with its clauses and
 *     periods reordered. Wrapping the value in RLE…PDF (U+202B…U+202C) sets the
 *     base direction to RTL without touching layout, which fixes the ordering.
 *     The Latin domain line is deliberately left unwrapped so it stays LTR.
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const b64 = (p) => fs.readFileSync(path.join(ROOT, p)).toString("base64");
const poppins = (weight) =>
  b64(`node_modules/@fontsource/poppins/files/poppins-latin-${weight}-normal.woff2`);
const notoArabic = (weight) =>
  b64(
    `node_modules/@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-${weight}-normal.woff2`,
  );

const dict = (lng) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, `src/lib/i18n/${lng}.json`), "utf8"));

const BG = "#09090b";
const FG = "#fafafa";
const MUTED = "#a1a1aa";
const GREEN = "#66bb6a"; // brand green on ink, oklch(0.718 0.142 145)

const MARK = "M 57 4 Q 79 34 83 66 Q 58 98 41 136 Q 30 98 17 64 Q 39 32 57 4 Z";
const MARGIN = 80;
const RIGHT = 1200 - MARGIN; // 1120

const escapeXml = (v) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Per-locale layout. `anchor`/`x` flip the whole card; the mark sits on the
 * leading edge either way (left in English, right in Arabic), mirroring how the
 * site header renders the lockup.
 */
const LOCALES = {
  en: {
    rtl: false,
    out: "public/og.png",
    weights: { 700: poppins(700), 600: poppins(600), 400: poppins(400) },
    anchor: "start",
    x: MARGIN,
    // Latin wordmark keeps the brand's -0.03em tracking (≈ -1.2 at 40px).
    wordmarkTracking: -1.2,
    // Mark spans x 80..102; the word clears it by 14px.
    markTransform: `translate(${MARGIN} 98) scale(0.333) translate(-17 -70)`,
    wordmarkX: MARGIN + 36,
  },
  ar: {
    rtl: true,
    out: "public/og.ar.png",
    weights: { 700: notoArabic(700), 600: notoArabic(600), 400: notoArabic(400) },
    anchor: "end",
    x: RIGHT,
    // Arabic is cursive — negative tracking crowds the joins.
    wordmarkTracking: 0,
    // Mirrored: the mark spans x 1098..1120, hugging the right margin.
    markTransform: `translate(${RIGHT} 98) scale(0.333) translate(-83 -70)`,
    wordmarkX: RIGHT - 36,
  },
};

function card(lng) {
  const L = LOCALES[lng];
  const t = dict(lng);
  const need = (key) => {
    const v = t[key];
    if (typeof v !== "string") {
      throw new Error(`generate-og: ${lng}.json is missing "${key}".`);
    }
    return L.rtl ? `‫${escapeXml(v)}‬` : escapeXml(v);
  };

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <style>
      @font-face{font-family:"P";font-weight:700;src:url(data:font/woff2;base64,${L.weights[700]}) format("woff2");}
      @font-face{font-family:"P";font-weight:600;src:url(data:font/woff2;base64,${L.weights[600]}) format("woff2");}
      @font-face{font-family:"P";font-weight:400;src:url(data:font/woff2;base64,${L.weights[400]}) format("woff2");}
    </style>
    <radialGradient id="glow" cx="88%" cy="8%" r="70%">
      <stop offset="0%" stop-color="${GREEN}" stop-opacity="0.16"/>
      <stop offset="55%" stop-color="${GREEN}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="${BG}"/>
  <rect width="1200" height="630" fill="url(#glow)"/>

  <g transform="${L.markTransform}"><path d="${MARK}" fill="${GREEN}"/></g>
  <text x="${L.wordmarkX}" y="112" font-family="P" font-weight="600" font-size="40" letter-spacing="${L.wordmarkTracking}" fill="${FG}" text-anchor="${L.anchor}">${need("brand.wordmark")}</text>

  <text x="${L.x}" y="320" font-family="P" font-weight="700" font-size="88" fill="${FG}" text-anchor="${L.anchor}">${need("og.headline.a")}</text>
  <text x="${L.x}" y="420" font-family="P" font-weight="700" font-size="88" fill="${GREEN}" text-anchor="${L.anchor}">${need("og.headline.b")}</text>

  <text x="${L.x}" y="498" font-family="P" font-weight="400" font-size="30" fill="${MUTED}" text-anchor="${L.anchor}">${need("og.tagline")}</text>

  <text x="${L.x}" y="566" font-family="P" font-weight="600" font-size="24" fill="#71717a" text-anchor="${L.anchor}">tasfer.app</text>
</svg>`;
}

for (const lng of Object.keys(LOCALES)) {
  const out = path.join(ROOT, LOCALES[lng].out);
  await sharp(Buffer.from(card(lng))).png().toFile(out);
  const meta = await sharp(out).metadata();
  const { size } = fs.statSync(out);
  console.log(
    `wrote ${LOCALES[lng].out} ${meta.width}x${meta.height}, ${(size / 1024).toFixed(0)} KB`,
  );
}
