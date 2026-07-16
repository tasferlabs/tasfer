/**
 * Generates the social share card at public/og.png (1200×630, the OpenGraph /
 * Twitter summary_large_image size). Run after changing the promise copy, the
 * brand accent, or the logo:
 *
 *   node scripts/generate-og.mjs
 *
 * The card is built as an SVG and rasterized with sharp. Poppins (the brand * face) is embedded as a base64 @font-face so the type renders identically
 * regardless of which fonts the build machine has installed — librsvg resolves
 * the embedded face rather than falling back to a system font.
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const b64 = (p) => fs.readFileSync(path.join(ROOT, p)).toString("base64");
const font = (weight) =>
  b64(`node_modules/@fontsource/poppins/files/poppins-latin-${weight}-normal.woff2`);

const poppins700 = font(700);
const poppins600 = font(600);
const poppins400 = font(400);

const BG = "#09090b";
const FG = "#fafafa";
const MUTED = "#a1a1aa";
const GREEN = "#66bb6a"; // brand green on ink, oklch(0.718 0.142 145)

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <style>
      @font-face{font-family:"P";font-weight:700;src:url(data:font/woff2;base64,${poppins700}) format("woff2");}
      @font-face{font-family:"P";font-weight:600;src:url(data:font/woff2;base64,${poppins600}) format("woff2");}
      @font-face{font-family:"P";font-weight:400;src:url(data:font/woff2;base64,${poppins400}) format("woff2");}
    </style>
    <radialGradient id="glow" cx="88%" cy="8%" r="70%">
      <stop offset="0%" stop-color="${GREEN}" stop-opacity="0.16"/>
      <stop offset="55%" stop-color="${GREEN}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="${BG}"/>
  <rect width="1200" height="630" fill="url(#glow)"/>

  <g transform="translate(80 98) scale(0.333) translate(-17 -70)"><path d="M 57 4 Q 79 34 83 66 Q 58 98 41 136 Q 30 98 17 64 Q 39 32 57 4 Z" fill="${GREEN}"/></g>
  <text x="116" y="112" font-family="P" font-weight="600" font-size="40" letter-spacing="-1.2" fill="${FG}">tasfer</text>

  <text x="80" y="320" font-family="P" font-weight="700" font-size="88" fill="${FG}">Your thoughts</text>
  <text x="80" y="420" font-family="P" font-weight="700" font-size="88" fill="${GREEN}">stay yours.</text>

  <text x="82" y="498" font-family="P" font-weight="400" font-size="30" fill="${MUTED}">Private, end-to-end encrypted markdown. No cloud. No account.</text>

  <text x="80" y="566" font-family="P" font-weight="600" font-size="24" fill="#71717a">tasfer.app</text>
</svg>`;

const out = path.join(ROOT, "public/og.png");
await sharp(Buffer.from(svg)).png().toFile(out);
const meta = await sharp(out).metadata();
const { size } = fs.statSync(out);
console.log(`wrote public/og.png ${meta.width}x${meta.height}, ${(size / 1024).toFixed(0)} KB`);
