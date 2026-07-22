/**
 * Regenerates every brand asset in the repository from the tasfer sifr mark.
 *
 * Renditions:
 *  - "mark": the green sifr glyph (brand/logo.svg) — the word صفر (zero)
 *    drawn as a single calligraphic stroke — on a transparent background:
 *    in-app wordmarks, readme, anywhere the mark sits on arbitrary surfaces.
 *    Green #43a047 on light surfaces, #66bb6a on ink/dark surfaces.
 *  - "icon": the app-icon rendition — the #43a047 glyph on a transparent
 *    canvas, no plate. Favicons, PWA icons, and the desktop icons, where the
 *    host surface is meant to show through.
 *  - The mobile launcher icons are opaque instead: a white plate on light, an
 *    ink (#101012) plate on dark, behind the same green glyph. On iOS this is
 *    forced — App Store validation rejects an icon carrying alpha — and
 *    Android matches it so the two platforms read the same. The iOS tinted
 *    appearance, which Apple composites over its own background, is the one
 *    variant that keeps its transparency.
 *  - splash screens: the inverse of the icon — a solid #43a047 field with a
 *    white glyph in the middle.
 *
 * Usage: cd brand && npm install && npm run generate
 * (macOS required for the .icns step, which shells out to `iconutil`.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GREEN = "#43a047"; // mark on light surfaces, app-icon glyph, splash plate
const INK = "#101012"; // iOS dark-appearance plate

// ---------------------------------------------------------------------------
// Geometry — the sifr glyph lives in a 100x140 space, matching brand/logo.svg.
// Visual bounding box: x 17..83, y 4..136 → center (50, 70), height 132.
// ---------------------------------------------------------------------------
const GLYPH_PATH =
  "M 57 4 Q 79 34 83 66 Q 58 98 41 136 Q 30 98 17 64 Q 39 32 57 4 Z";
const GLYPH_CX = 50;
const GLYPH_CY = 70;
const GLYPH_HEIGHT = 132;

const fmt = (n) => String(Math.round(n * 1000) / 1000);

/**
 * Compose an icon: an optional full-bleed plate + the glyph centered in a
 * width x height canvas. Plates are used wherever the platform wants an opaque
 * icon face; the web and desktop renditions leave the canvas transparent.
 *  - glyph: fraction of the canvas' short edge the glyph's height spans
 *  - radius: plate corner radius as a fraction of the canvas' short edge
 *    (0 = square, 0.5 = circle). Only the pre-API-26 Android icons need it —
 *    iOS and modern Android launchers apply their own mask.
 */
function iconSvg({
  size,
  width = size,
  height = size,
  plate = null,
  radius = 0,
  glyph = 0.6,
  fill = GREEN,
}) {
  const parts = [];
  if (plate) {
    const rx = fmt(radius * Math.min(width, height));
    parts.push(
      `<rect width="${width}" height="${height}" rx="${rx}" fill="${plate}"/>`,
    );
  }
  const k = (glyph * Math.min(width, height)) / GLYPH_HEIGHT;
  parts.push(
    `<g transform="translate(${fmt(width / 2)} ${fmt(height / 2)}) scale(${fmt(k)}) translate(${-GLYPH_CX} ${-GLYPH_CY})"><path d="${GLYPH_PATH}" fill="${fill}"/></g>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
}

/**
 * Full-canvas splash: solid green with a centered white glyph — the inverse of
 * the app icon. Note this does not match `ios.backgroundColor` /
 * `android.backgroundColor` in apps/web/capacitor.config.js (ink), which is
 * painted between the splash going away and the web content's first paint.
 */
function splashSvg(width, height, glyph = 0.22) {
  const k = (glyph * Math.min(width, height)) / GLYPH_HEIGHT;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${GREEN}"/>` +
    `<g transform="translate(${fmt(width / 2)} ${fmt(height / 2)}) scale(${fmt(k)}) translate(${-GLYPH_CX} ${-GLYPH_CY})"><path d="${GLYPH_PATH}" fill="#ffffff"/></g>` +
    `</svg>`
  );
}

async function png(svg, out) {
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log("wrote", path.relative(ROOT, out));
}

/**
 * Same, but written without an alpha channel. App Store validation rejects an
 * app icon that merely *carries* alpha (ITMS-90717), even when every pixel is
 * fully opaque, so the iOS light and dark appearances must be flattened.
 */
async function pngOpaque(svg, out) {
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  await sharp(Buffer.from(svg)).removeAlpha().png().toFile(out);
  console.log("wrote", path.relative(ROOT, out), "(no alpha)");
}

const at = (...p) => path.join(ROOT, ...p);

// ---------------------------------------------------------------------------
// Renditions
// ---------------------------------------------------------------------------
const mark = (size) => iconSvg({ size, glyph: 0.94 });
/** App icon: the green glyph on a transparent canvas, no plate. */
const icon = (size, glyph = 0.86) => iconSvg({ size, glyph });
/** iOS only — opaque plate behind the glyph, since Apple forbids alpha. */
const iosIcon = (plate, fill = GREEN) =>
  iconSvg({ size: 1024, plate, fill, glyph: 0.52 });
/**
 * Android legacy (pre-API-26) launcher icons. These are drawn as-is — no
 * adaptive layers, no launcher mask — so the plate carries its own shape and
 * cannot follow the system theme the way the adaptive background does.
 */
const androidLegacy = (size, glyph, radius) =>
  iconSvg({ size, plate: "#ffffff", radius, glyph });

async function main() {
  // The bare mark (transparent, green) — readme, site headers, app chrome.
  for (const out of [
    at("logo.png"),
    at("apps", "web", "public", "logo.png"),
    at("apps", "site", "public", "logo.png"),
  ]) {
    await png(mark(1024), out);
  }

  // Favicons and PWA icons. Transparent, so these are declared `purpose: any`
  // in the web manifest — a maskable icon would need an opaque full-bleed
  // plate, which is exactly what this rendition drops.
  await png(icon(32, 0.94), at("apps", "web", "public", "favicon.png"));
  await png(icon(64, 0.94), at("apps", "site", "public", "favicon.png"));
  await png(icon(192), at("apps", "web", "public", "icon-192.png"));
  await png(icon(512), at("apps", "web", "public", "icon-512.png"));

  // Desktop (Electron).
  const res = at("apps", "desktop", "resources");
  await png(icon(512), path.join(res, "icon.png"));
  await png(icon(1024), path.join(res, "icon-1024.png"));
  // macOS template tray icon: black glyph + alpha, tinted by the system.
  await png(
    iconSvg({ size: 22, fill: "#000000", glyph: 0.82 }),
    path.join(res, "trayIconTemplate.png"),
  );
  await png(
    iconSvg({ size: 44, fill: "#000000", glyph: 0.82 }),
    path.join(res, "trayIconTemplate@2x.png"),
  );

  // icon.ico (Windows).
  const icoTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tasfer-ico-"));
  const icoPngs = [];
  for (const s of [16, 24, 32, 48, 64, 128, 256]) {
    const p = path.join(icoTmp, `icon-${s}.png`);
    await sharp(Buffer.from(icon(s, 0.9))).png().toFile(p);
    icoPngs.push(p);
  }
  fs.writeFileSync(path.join(res, "icon.ico"), await pngToIco(icoPngs));
  console.log("wrote", path.relative(ROOT, path.join(res, "icon.ico")));

  // icon.icns (macOS) — the glyph fills the Big Sur content box (~0.8 of the
  // canvas); the surrounding margin is transparent rather than a plate.
  const icnsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tasfer-icns-"));
  const iconset = path.join(icnsTmp, "icon.iconset");
  fs.mkdirSync(iconset);
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [suffix, px] of [
      ["", s],
      ["@2x", s * 2],
    ]) {
      const svg = icon(px, 0.8);
      await sharp(Buffer.from(svg))
        .png()
        .toFile(path.join(iconset, `icon_${s}x${s}${suffix}.png`));
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(res, "icon.icns")]);
  console.log("wrote", path.relative(ROOT, path.join(res, "icon.icns")));

  // iOS app icon (full bleed — iOS applies its own mask) and splash screens.
  // App Store validation rejects an alpha channel, so the light and dark
  // appearances are opaque: a white / ink plate behind the green glyph. The
  // tinted appearance is a grayscale glyph on alpha, which iOS composites over
  // its own background — the one place transparency is allowed.
  const appiconset = at("apps", "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset");
  await pngOpaque(iosIcon("#ffffff"), path.join(appiconset, "AppIcon.png"));
  await pngOpaque(iosIcon(INK), path.join(appiconset, "AppIcon-dark.png"));
  await png(
    iconSvg({ size: 1024, fill: "#ffffff", glyph: 0.52 }),
    path.join(appiconset, "AppIcon-tinted.png"),
  );
  const splashset = at("apps", "ios", "App", "App", "Assets.xcassets", "Splash.imageset");
  for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
    await png(splashSvg(2732, 2732), path.join(splashset, name));
  }

  // Android launcher icons — an opaque icon face, like iOS. The adaptive
  // background color lives in res/values/ic_launcher_background.xml (white)
  // and res/values-night/ic_launcher_background.xml (ink).
  const resDir = at("apps", "android", "app", "src", "main", "res");
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [dpi, m] of Object.entries(densities)) {
    const dir = path.join(resDir, `mipmap-${dpi}`);
    // Adaptive foreground: the green glyph on alpha, so the background layer
    // shows through — the layering is what makes the composed icon opaque.
    // 0.42 of the 108dp canvas sits inside the 66dp safe zone and matches the
    // glyph's optical size on the iOS plate.
    await png(iconSvg({ size: 108 * m, glyph: 0.42 }), path.join(dir, "ic_launcher_foreground.png"));
    await png(androidLegacy(48 * m, 0.54, 0.2), path.join(dir, "ic_launcher.png"));
    await png(androidLegacy(48 * m, 0.5, 0.5), path.join(dir, "ic_launcher_round.png"));
  }

  // Android splash screens (dimensions match the checked-in Capacitor set).
  await png(splashSvg(480, 320), path.join(resDir, "drawable", "splash.png"));
  const splashDims = { mdpi: [480, 320], hdpi: [800, 480], xhdpi: [1280, 720], xxhdpi: [1600, 960], xxxhdpi: [1920, 1280] };
  for (const [dpi, [long, short]] of Object.entries(splashDims)) {
    await png(splashSvg(long, short), path.join(resDir, `drawable-land-${dpi}`, "splash.png"));
    await png(splashSvg(short, long), path.join(resDir, `drawable-port-${dpi}`, "splash.png"));
  }
}

await main();
