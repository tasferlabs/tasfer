#!/usr/bin/env node
// Playwright driver for the Tasfer web app.
//
// The editor renders to <canvas>, so the DOM is nearly empty where the
// document lives — you CANNOT assert on document text via selectors. Drive it
// like a user: click into the canvas to focus, type on the keyboard, and
// SCREENSHOT to observe. Text input flows through a hidden contenteditable, so
// page.keyboard.type() reaches the editor once the canvas is focused.
//
// By default the driver uses a PERSISTENT profile (./.pw-profile), so it does
// the onboarding walk ONCE, persists the space to that profile's IndexedDB, and
// skips it on every later run. Pass --fresh for a throwaway incognito context
// that re-onboards (what `smoke` uses to demo the full cold path).
//
// Usage:
//   node driver.mjs shot   <out.png> [--url URL] [--headed] [--fresh]
//   node driver.mjs smoke  [--out DIR] [--headed]   # staged screenshots
//   node driver.mjs eval   "<js returning a value>" [--fresh]
//   node driver.mjs reset                           # delete the saved profile
//
// Env: URL   base url (default http://localhost:4000)

import { chromium } from "playwright";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.URL || "http://localhost:4000";
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);
const ensureDir = (p) => mkdirSync(dirname(resolve(p)), { recursive: true });
const PROFILE = resolve(flag("profile", resolve(HERE, ".pw-profile")));
const VIEWPORT = { width: 1280, height: 900 };

// Persistent profile (default) keeps the onboarded space in IndexedDB so later
// runs skip the gate. --fresh gives a throwaway incognito context.
async function launch({ fresh } = {}) {
  const wire = (page) => {
    page.on("console", (m) => {
      if (m.type() === "error") console.error("[page error]", m.text());
    });
    page.on("pageerror", (e) => console.error("[pageerror]", e.message));
    return page;
  };
  if (fresh || has("fresh")) {
    const browser = await chromium.launch({ headless: !has("headed") });
    const page = wire(await browser.newPage({ viewport: VIEWPORT }));
    return { page, close: () => browser.close() };
  }
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: !has("headed"),
    viewport: VIEWPORT,
  });
  const page = wire(ctx.pages()[0] || (await ctx.newPage()));
  return { page, close: () => ctx.close() };
}

// #loading spinner is replaced by React once fonts + app are ready.
async function waitBoot(page, ms = 12000) {
  await page
    .waitForFunction(() => !document.getElementById("loading"), null, {
      timeout: ms,
    })
    .catch(() => {});
  await page.waitForTimeout(400);
}

// Walk the onboarding carousel by clicking its primary button
// (Continue → Continue → Just continue). Returns the number of steps clicked
// (0 on a warm profile where onboarding is already done).
async function onboard(page, ms = 15000) {
  const deadline = Date.now() + ms;
  let steps = 0;
  while (Date.now() < deadline) {
    const primary = page.locator(".ob-btn-primary:visible").last();
    if (!(await primary.count())) break; // not in the carousel
    await primary.click().catch(() => {});
    steps++;
    await page.waitForTimeout(700); // "Just continue" persists a space async
  }
  return steps;
}

// A space starts with no pages; the editor <canvas> only mounts once a page is
// open. Click "Create new page" (empty-state CTA) if no page is already open.
async function newPage(page, ms = 10000) {
  if (await page.locator("canvas").count()) return true;
  const cta = page.getByRole("button", { name: /create new page/i }).first();
  await cta.click({ timeout: ms }).catch(() => {});
  await page.waitForSelector("canvas", { timeout: ms }).catch(() => {});
  await page.waitForTimeout(500);
  return (await page.locator("canvas").count()) > 0;
}

// Full path to an open editor canvas. On a warm profile this is just a load.
async function open(page) {
  await page.goto(flag("url", BASE), { waitUntil: "domcontentloaded" });
  await waitBoot(page);
  const steps = await onboard(page);
  await newPage(page);
  await page.waitForTimeout(400);
  console.log(
    steps ? `onboarded (${steps} steps)` : "warm start (onboarding skipped)",
  );
}

async function cmdShot() {
  const out = argv[1];
  if (!out) throw new Error("usage: driver.mjs shot <out.png>");
  ensureDir(out);
  const { page, close } = await launch();
  await open(page);
  await page.screenshot({ path: out });
  console.log("wrote", out);
  await close();
}

async function cmdSmoke() {
  const dir = flag("out", "/tmp/tasfer-smoke");
  mkdirSync(dir, { recursive: true });
  const { page, close } = await launch({ fresh: true }); // always demo the cold path

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await waitBoot(page);
  await page.screenshot({ path: `${dir}/01-onboarding.png` });
  console.log("01-onboarding:", await page.title());

  await onboard(page);
  await page.screenshot({ path: `${dir}/02-space-home.png` });
  console.log("02-space-home: onboarded into Personal space");

  const reached = await newPage(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/03-editor.png` });
  console.log("03-editor: canvas mounted =", reached);
  if (!reached) throw new Error("never reached the editor canvas");

  // Focus the canvas and type. Content lands on canvas — observe via screenshot.
  const box = await page.locator("canvas").first().boundingBox();
  await page.mouse.click(box.x + 120, box.y + 90);
  await page.waitForTimeout(200);
  await page.keyboard.type("Hello from the driver.", { delay: 25 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("This is a second line.", { delay: 25 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/04-typed.png` });
  console.log("04-typed: typed two lines into the canvas");

  await close();
  console.log("smoke done ->", dir);
}

async function cmdEval() {
  const expr = argv[1];
  if (!expr) throw new Error('usage: driver.mjs eval "<js>"');
  const { page, close } = await launch();
  await open(page);
  const val = await page.evaluate(`(async()=>{ return (${expr}); })()`);
  console.log(JSON.stringify(val, null, 2));
  await close();
}

async function cmdReset() {
  rmSync(PROFILE, { recursive: true, force: true });
  console.log("removed profile", PROFILE);
}

const cmds = { shot: cmdShot, smoke: cmdSmoke, eval: cmdEval, reset: cmdReset };
const fn = cmds[cmd];
if (!fn) {
  console.error(
    "commands: shot <out.png> | smoke [--out DIR] | eval <js> | reset",
  );
  process.exit(2);
}
fn().catch((e) => {
  console.error(e);
  process.exit(1);
});
