/**
 * Regenerates every brand asset in the repository from the tasfer sifr mark.
 *
 * Renditions:
 *  - "mark": the green sifr glyph (brand/logo.svg) — the word صفر (zero)
 *    drawn as a single calligraphic stroke — on a transparent background:
 *    in-app wordmarks, readme, anywhere the mark sits on arbitrary surfaces.
 *    Green #43a047 on light surfaces, #66bb6a on ink/dark surfaces.
 *  - "plate": the app-icon rendition — white glyph on a solid green (#43a047)
 *    plate — used for favicons, PWA icons, and desktop/iOS/Android launcher
 *    icons.
 *  - splash screens: ink (#101012) background with the #66bb6a glyph.
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

const GREEN = "#43a047"; // mark on light surfaces, icon plate
const GREEN_DARK = "#66bb6a"; // mark on ink/dark surfaces
const INK = "#101012"; // splash background

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
 * Compose an icon: optional plate + glyph centered in a width x height canvas.
 *  - glyph: fraction of the canvas' short edge the glyph's height spans
 *  - radius: plate corner radius as a fraction of the plate edge
 *  - margin: transparent margin around the plate, fraction of the canvas
 */
function iconSvg({
  size,
  width = size,
  height = size,
  plate = null,
  radius = 0,
  margin = 0,
  glyph = 0.6,
  fill = "#ffffff",
}) {
  const parts = [];
  if (plate) {
    const edge = Math.min(width, height) * (1 - 2 * margin);
    const x = (width - edge) / 2;
    const y = (height - edge) / 2;
    parts.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(edge)}" height="${fmt(edge)}" rx="${fmt(radius * edge)}" fill="${plate}"/>`,
    );
  }
  const k = (glyph * Math.min(width, height)) / GLYPH_HEIGHT;
  parts.push(
    `<g transform="translate(${fmt(width / 2)} ${fmt(height / 2)}) scale(${fmt(k)}) translate(${-GLYPH_CX} ${-GLYPH_CY})"><path d="${GLYPH_PATH}" fill="${fill}"/></g>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
}

/** Full-canvas splash: ink background with a centered green glyph. */
function splashSvg(width, height, glyph = 0.22) {
  const k = (glyph * Math.min(width, height)) / GLYPH_HEIGHT;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${INK}"/>` +
    `<g transform="translate(${fmt(width / 2)} ${fmt(height / 2)}) scale(${fmt(k)}) translate(${-GLYPH_CX} ${-GLYPH_CY})"><path d="${GLYPH_PATH}" fill="${GREEN_DARK}"/></g>` +
    `</svg>`
  );
}

async function png(svg, out) {
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log("wrote", path.relative(ROOT, out));
}

const at = (...p) => path.join(ROOT, ...p);

// ---------------------------------------------------------------------------
// Renditions
// ---------------------------------------------------------------------------
const mark = (size) => iconSvg({ size, fill: GREEN, glyph: 0.94 });
const plate = (size, { glyph = 0.56, radius = 0.2237, margin = 0 } = {}) =>
  iconSvg({ size, plate: GREEN, radius, margin, glyph });
const plateSquare = (size, glyph) => iconSvg({ size, plate: GREEN, glyph });
const plateCircle = (size, glyph) =>
  iconSvg({ size, plate: GREEN, radius: 0.5, glyph });

async function main() {
  // Master vector for the plate rendition, kept next to logo.svg for reuse.
  fs.writeFileSync(at("brand", "logo-plate.svg"), plate(64) + "\n");

  // The bare mark (transparent, green) — readme, site headers, app chrome.
  for (const out of [
    at("logo.png"),
    at("apps", "web", "public", "logo.png"),
    at("apps", "site", "public", "logo.png"),
  ]) {
    await png(mark(1024), out);
  }

  // Favicons and PWA icons (plate rendition).
  await png(plate(32, { glyph: 0.6 }), at("apps", "web", "public", "favicon.png"));
  await png(plate(64, { glyph: 0.6 }), at("apps", "site", "public", "favicon.png"));
  // Maskable PWA icons are full-bleed; keep the glyph inside the safe zone.
  await png(plateSquare(192, 0.5), at("apps", "web", "public", "icon-192.png"));
  await png(plateSquare(512, 0.5), at("apps", "web", "public", "icon-512.png"));

  // Desktop (Electron).
  const res = at("apps", "desktop", "resources");
  await png(plate(512), path.join(res, "icon.png"));
  await png(plate(1024), path.join(res, "icon-1024.png"));
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
    await sharp(Buffer.from(plate(s, { glyph: 0.6 }))).png().toFile(p);
    icoPngs.push(p);
  }
  fs.writeFileSync(path.join(res, "icon.ico"), await pngToIco(icoPngs));
  console.log("wrote", path.relative(ROOT, path.join(res, "icon.ico")));

  // icon.icns (macOS) — Big Sur style: rounded plate with a transparent margin.
  const icnsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tasfer-icns-"));
  const iconset = path.join(icnsTmp, "icon.iconset");
  fs.mkdirSync(iconset);
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [suffix, px] of [
      ["", s],
      ["@2x", s * 2],
    ]) {
      const svg = plate(px, { glyph: 0.52, margin: 0.09 });
      await sharp(Buffer.from(svg))
        .png()
        .toFile(path.join(iconset, `icon_${s}x${s}${suffix}.png`));
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(res, "icon.icns")]);
  console.log("wrote", path.relative(ROOT, path.join(res, "icon.icns")));

  // iOS app icon (full bleed — iOS applies its own mask) and splash screens.
  const appiconset = at("apps", "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset");
  await png(plateSquare(1024, 0.52), path.join(appiconset, "AppIcon.png"));
  await png(plateSquare(1024, 0.52), path.join(appiconset, "AppIcon-512@2x.png"));
  const splashset = at("apps", "ios", "App", "App", "Assets.xcassets", "Splash.imageset");
  for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
    await png(splashSvg(2732, 2732), path.join(splashset, name));
  }

  // Android launcher icons. The adaptive-icon background color lives in
  // res/values/ic_launcher_background.xml and must stay GREEN.
  const resDir = at("apps", "android", "app", "src", "main", "res");
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [dpi, m] of Object.entries(densities)) {
    const dir = path.join(resDir, `mipmap-${dpi}`);
    // Adaptive foreground: transparent, white glyph inside the 66/108 safe zone.
    await png(iconSvg({ size: 108 * m, glyph: 0.42 }), path.join(dir, "ic_launcher_foreground.png"));
    await png(plate(48 * m, { glyph: 0.54, radius: 0.2 }), path.join(dir, "ic_launcher.png"));
    await png(plateCircle(48 * m, 0.5), path.join(dir, "ic_launcher_round.png"));
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
