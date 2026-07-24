#!/usr/bin/env node
// Seed the Tasfer web app with showcase content and capture the PWA manifest
// screenshots (public/screenshots/*, referenced by scripts/gen-manifest.mjs).
//
// Reuses the run-web skill's Playwright install and persistent .pw-profile (the
// profile's space gets wiped and reseeded — run `driver.mjs reset` afterwards
// if you want the cold onboarding flow back).
//
// Usage:
//   node scripts/seed-shoot.mjs [--out DIR] [--publish] [--headed]
//
// Shots land in --out (default /tmp/tasfer-pwa-shots). --publish additionally
// copies the canonical shots into apps/web/public/screenshots/.
//
// Env: URL   base url (default http://localhost:4000)

import { createRequire } from "node:module";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..");
const RUN_WEB_SKILL = join(WEB_ROOT, ".claude", "skills", "run-web");
const require = createRequire(join(RUN_WEB_SKILL, "package.json"));
const { chromium } = require("playwright");
const BASE = process.env.URL || "http://localhost:4000";
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = resolve(flag("out", "/tmp/tasfer-pwa-shots"));
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Showcase content. File-name order == sidebar order. H1 becomes the title;
// frontmatter `color` sets the sidebar blob color (app preset palette).
// ---------------------------------------------------------------------------
const ROOT_FILES = [
  [
    "01-roadmap.md",
    `---
color: #6366F1
---
# Product roadmap

Everything here lives on this device and syncs **peer-to-peer** — no server ever sees a word of it.

## Shipping in July

- [x] Canvas renderer — sub-pixel text metrics
- [x] Markdown and ZIP import
- [ ] Space invites with QR pairing
- [ ] Page templates

## Exploring

- Inline math in any paragraph: $E = mc^2$
- Daily notes with calendar scheduling
- Publish a page as a static site

> Local-first means the app never asks you to wait.
`,
  ],
  [
    "02-physics.md",
    `---
color: #06B6D4
---
# Wave mechanics

Week 3 lecture notes. A particle's state $\\psi(x, t)$ evolves under the Schrödinger equation:

$$
i\\hbar \\frac{\\partial \\psi}{\\partial t} = -\\frac{\\hbar^2}{2m} \\frac{\\partial^2 \\psi}{\\partial x^2} + V(x)\\,\\psi
$$

Plane waves $\\psi = e^{i(kx - \\omega t)}$ satisfy it with the free-particle dispersion:

$$
\\omega(k) = \\frac{\\hbar k^2}{2m}
$$

## Follow-ups

- [ ] Normalize the Gaussian wave packet
- [ ] Show the group velocity equals $\\partial \\omega / \\partial k$
`,
  ],
  [
    "03-meetings.md",
    `---
color: #F59E0B
---
# Meeting notes

One sub-page per sync. Decisions in **bold**, owners in parentheses.

## This week

- [x] Align the canvas shortcuts with the mobile toolbar
- [x] Ship the import improvements (Maya)
- [ ] Prepare the pairing flow for the next beta

**Decision:** keep every workspace fully local by default.

## Next sync

- Review the first-run experience
- Choose the page templates for launch
`,
  ],
  [
    "04-reading.md",
    `---
color: #22C55E
---
# Reading list

- [x] The Design of Everyday Things — Don Norman
- [x] Snow — Orhan Pamuk
- [ ] Gödel, Escher, Bach — Douglas Hofstadter
- [ ] The Left Hand of Darkness — Ursula K. Le Guin
`,
  ],
  [
    "05-travel.md",
    `---
color: #EC4899
---
# Weekend in Amman

- [ ] Book the Rainbow Street guesthouse
- [ ] Friday: Roman theatre, then knafeh at Habibah
- [ ] Saturday: day trip to Jerash
`,
  ],
  [
    "06-recipes.md",
    `---
color: #F97316
---
# Family recipes

- Mansaf — grandmother's proportions, do not improvise
- Maqluba for six
- Cardamom coffee ratios
`,
  ],
];

const CHILD_FILES = [
  [
    "01-design-sync.md",
    `# Design sync — Jul 14

- Sidebar density tweaks land next sprint (Dana)
- **Decision:** page chips follow the page color
`,
  ],
  [
    "02-retro.md",
    `# Sprint retro — Jul 21

- Import pipeline shipped a week early
- **Action:** write convergence tests for list reordering
`,
  ],
];

const PARENT_TITLE = "Meeting notes";

// Canonical source captures. The generic desktop/mobile files are used by the
// PWA manifest; the named mobile captures compose the App Store screenshots.
// Caret coords are CSS px clicks into a text line; "End" then snaps to the
// line end.
const PUBLISH = [
  ["desktop-light-roadmap.png", "desktop-light.png"],
  ["desktop-dark-physics.png", "desktop-dark.png"],
  ["mobile-light-roadmap.png", "mobile-light.png"],
  ["mobile-light-roadmap.png", "mobile-light-roadmap.png"],
  ["mobile-light-meetings.png", "mobile-light-meetings.png"],
  ["mobile-dark-physics.png", "mobile-dark.png"],
  ["mobile-dark-physics.png", "mobile-dark-physics.png"],
  ["mobile-dark-roadmap.png", "mobile-dark-roadmap.png"],
  ["mobile-light-sidebar.png", "mobile-sidebar.png"],
];

// ---------------------------------------------------------------------------

async function waitBoot(page, ms = 15000) {
  await page
    .waitForFunction(() => !document.getElementById("loading"), null, { timeout: ms })
    .catch(() => {});
  await page.waitForTimeout(500);
}

// Same walk as driver.mjs: click through onboarding if it appears.
async function onboard(page, ms = 15000) {
  const deadline = Date.now() + ms;
  let steps = 0;
  while (Date.now() < deadline) {
    const primary = page.locator(".ob-btn-primary:visible").last();
    if (!(await primary.count())) break;
    if (await primary.isDisabled().catch(() => false)) {
      await page.locator(".ob-input:visible").first().fill("tasfer-beta").catch(() => {});
    }
    await primary.click().catch(() => {});
    steps++;
    await page.waitForTimeout(700);
  }
  return steps;
}

async function setTheme(page, theme) {
  await page.evaluate((t) => localStorage.setItem("theme", t), theme);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitBoot(page);
}

async function gotoPage(page, id) {
  await page.goto(`${BASE}/page/${id}`, { waitUntil: "domcontentloaded" });
  await waitBoot(page);
  await page.waitForSelector("canvas", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200); // canvas paint + fonts
}

// Park the caret at the end of the text line at (x, y), then screenshot fast:
// the editor always draws the caret for one blinkInterval (530ms) after a
// cursor update, so shooting inside that window sidesteps blink entirely.
async function shotWithCaret(page, file, caret) {
  if (caret) {
    await page.mouse.click(caret.x, caret.y);
    await page.waitForTimeout(80);
    await page.keyboard.press("End");
    await page.waitForTimeout(140);
  }
  await page.screenshot({ path: join(OUT, file) });
}

async function scrollEditorToTop(page) {
  await page.mouse.move(200, 400);
  await page.mouse.wheel(0, -10_000);
  await page.waitForTimeout(100);
}

const ctx = await chromium.launchPersistentContext(
  join(RUN_WEB_SKILL, ".pw-profile"),
  {
    headless: !has("headed"),
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  },
);
const page = ctx.pages()[0] || (await ctx.newPage());
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
// Present as an installed app (the app's own iOS standalone signal), so the
// browser-tab-only storage nudge is hidden — screenshots depict the installed PWA.
await page.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, "standalone", { get: () => true });
});

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await waitBoot(page);
const steps = await onboard(page);
console.log(steps ? `onboarded (${steps} steps)` : "warm start");

// Seed: wipe existing pages, import the showcase set through the app's own
// markdown import pipeline (same modules the app uses, served by Vite).
const seeded = await page.evaluate(
  async ({ rootFiles, childFiles, parentTitle }) => {
    const { getPlatform } = await import("/src/platform/index.ts");
    const { importFilesToSpace } = await import("/src/lib/spaceImport.ts");
    const platform = getPlatform();
    const spaces = await platform.spaces.list();
    if (!spaces.length) throw new Error("no space — onboarding failed?");
    const spaceId = spaces[0].id;

    await navigator.storage?.persist?.().catch(() => false);
    await platform.spaces.rename(spaceId, "Personal").catch(() => {});
    await platform.identity.update({ name: "Dana" }).catch(() => {});

    const existing = await platform.pages.list(spaceId, undefined, { includeTasks: true });
    for (const p of existing) await platform.pages.delete(p.id).catch(() => {});

    const toFile = ([name, text]) => new File([text], name, { type: "text/markdown" });
    const rootResult = await importFilesToSpace(rootFiles.map(toFile), spaceId);

    const roots = await platform.pages.list(spaceId, undefined, { includeTasks: true });
    const parent = roots.find((p) => p.title === parentTitle);
    let childResult = null;
    if (parent) {
      childResult = await importFilesToSpace(childFiles.map(toFile), spaceId, {
        parentId: parent.id,
      });
    }
    return {
      spaceId,
      errors: [...rootResult.errors, ...(childResult?.errors ?? [])],
      pages: roots.map((p) => ({ id: p.id, title: p.title, color: p.color })),
    };
  },
  { rootFiles: ROOT_FILES, childFiles: CHILD_FILES, parentTitle: PARENT_TITLE },
);
if (seeded.errors.length) console.error("IMPORT ERRORS:", seeded.errors);
console.log("seeded", seeded.pages.length, "root pages");

const byTitle = Object.fromEntries(seeded.pages.map((p) => [p.title, p.id]));
const roadmap = byTitle["Product roadmap"];
const physics = byTitle["Wave mechanics"];

// The active route can point at a page just deleted during seeding. Return to
// the app root before selecting a freshly imported page.
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await waitBoot(page);

// --- Desktop, light -------------------------------------------------------
await setTheme(page, "light");
await gotoPage(page, roadmap);
// Caret: end of the "Space invites with QR pairing" todo.
await shotWithCaret(page, "desktop-light-roadmap.png", { x: 570, y: 385 });
await gotoPage(page, physics);
await page.screenshot({ path: join(OUT, "desktop-light-physics.png") });

// --- Desktop, dark --------------------------------------------------------
await setTheme(page, "dark");
await gotoPage(page, physics);
// Caret: end of the "Normalize the Gaussian wave packet" todo.
await shotWithCaret(page, "desktop-dark-physics.png", { x: 590, y: 623 });
await gotoPage(page, roadmap);
await page.screenshot({ path: join(OUT, "desktop-dark-roadmap.png") });

// --- Mobile ---------------------------------------------------------------
await page.setViewportSize({ width: 390, height: 844 });
// The capture profile is persistent, so never inherit a sidebar left open by
// a previous run.
await page.evaluate(() => localStorage.setItem("floating-sidebar-open", "false"));
await setTheme(page, "light");
await gotoPage(page, roadmap);
// Caret: end of the intro paragraph ("…a word of it.").
await shotWithCaret(page, "mobile-light-roadmap.png", { x: 180, y: 195 });

await gotoPage(page, byTitle["Meeting notes"]);
await page.screenshot({ path: join(OUT, "mobile-light-meetings.png") });

await gotoPage(page, roadmap);

// Sidebar navigation with the showcase tree visible. This is the page sidebar,
// not the app Preferences or Page settings drawer.
await page.getByRole("button", { name: /open sidebar/i }).click();
await page.waitForTimeout(250);
await page.screenshot({ path: join(OUT, "mobile-light-sidebar.png") });
// Navigate through the floating sidebar so it closes before the math capture.
await page.getByText("Wave mechanics", { exact: true }).click();
await page
  .getByRole("button", { name: /open sidebar/i })
  .waitFor({ state: "visible" });

await setTheme(page, "dark");
await gotoPage(page, physics);
await scrollEditorToTop(page);
// Caret: end of the "Normalize the Gaussian wave packet" todo.
await shotWithCaret(page, "mobile-dark-physics.png", { x: 200, y: 696 });

await gotoPage(page, roadmap);
await page.screenshot({ path: join(OUT, "mobile-dark-roadmap.png") });

// Restore light for future driver runs.
await page.setViewportSize({ width: 1280, height: 800 });
await setTheme(page, "light");

await ctx.close();

if (has("publish")) {
  const dest = join(WEB_ROOT, "public", "screenshots");
  mkdirSync(dest, { recursive: true });
  for (const [src, out] of PUBLISH) {
    copyFileSync(join(OUT, src), join(dest, out));
    console.log("published", out);
  }
}
console.log("done ->", OUT);
