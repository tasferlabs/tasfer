#!/usr/bin/env node
// Record a demo video of the Tasfer editor being typed into.
//
// A scenario says what to type. This script opens the app in a fresh browser
// profile, makes a new page, types the scenario with real key presses at a
// human pace, and saves an .mp4. Under the editor, a keycap flashes the key
// being pressed.
//
// The video shows the whole app: the sidebar, the top bar and the Schedule /
// Add cover row. With --canvas it shows only the editor canvas instead. The
// sidebar is filled with a few coloured pages first; a scenario can name its
// own with
// `export const sidebar = [{ title, color }]` (colours from the app's page
// colour picker, such as "#3B82F6"), and name the space with
// `export const space = "…"`.
//
// A scenario that exports `peers` (say `["Alice", "Bob"]`) is recorded with
// one fresh profile per peer. Before recording, the first peer makes a page
// and invites the others into their space with an invite code, so everyone
// edits the same page live. The video shows the first peer's screen; the
// others appear on it as named carets. The scenario gets one Director per
// peer, keyed by the
// name in lower case. This needs the signaling server the app is set up with
// (wss://signaling.tasfer.app unless VITE_SIGNAL_URL says otherwise).
//
// Usage (from apps/web, with the dev server running):
//   node scripts/demo-video/record.mjs maths
//   node scripts/demo-video/record.mjs peers-maths
//   node scripts/demo-video/record.mjs path/to/scenario.mjs --dark --speed 1.5
//
// Options:
//   --url URL      app to record (default http://localhost:4000, or $URL)
//   --out DIR      where the video goes (default <repo>/out/demo-videos)
//   --size WxH     video size in CSS pixels
//                  (default 1280x720)
//   --scale N      pixel density; the video is size × scale (default 2)
//   --speed N      typing speed multiplier (default 1)
//   --dark         record the dark theme
//   --serif        use the app's serif page font
//   --canvas       show only the editor canvas, not the whole app
//   --wide         run the text at full width instead of the reading column
//   --headed       show the browser window while recording
//   --check        print the page as Markdown at the end
//   --no-video     type the scenario without recording (pair with --check)
//
// Set DEMO_DEBUG_DIR to a folder to get a screenshot of every page there when
// a run fails.
//
// Needs ffmpeg on PATH, and Playwright from skills/run-web
// (`npm install` in apps/web/skills/run-web once).

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { latexToKeys } from "./latex-keys.mjs";
import { shellHtml } from "./overlay.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");
const require = createRequire(
  join(WEB_ROOT, "skills", "run-web", "package.json"),
);

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const scenarioArg = argv[0];
if (!scenarioArg || scenarioArg.startsWith("--")) {
  console.error("Usage: node scripts/demo-video/record.mjs <scenario> [options]");
  process.exit(1);
}

const BASE = flag("url", process.env.URL || "http://localhost:4000");
const OUT = resolve(flag("out", join(REPO_ROOT, "out", "demo-videos")));
const [WIDTH, HEIGHT] = flag("size", "1280x720").split("x").map(Number);
const SCALE = Number(flag("scale", "2"));
const SPEED = Number(flag("speed", "1"));
const RECORD = !has("no-video");
const SHOW_APP = !has("canvas");

// Pages put in the sidebar, unless the scenario names its own.
// The space's name, unless the scenario gives one.
const SPACE_NAME = "Study group";
const SIDEBAR_PAGES = [
  { title: "Lecture notes", color: "#3B82F6" },
  { title: "Problem set 4", color: "#8B5CF6" },
  { title: "Reading list", color: "#F97316" },
  { title: "Trip to Lisbon", color: "#14B8A6" },
  { title: "Ideas", color: "#EAB308" },
];
const FPS = 60;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// How each named key reads in the overlay.
const KEY_LABELS = {
  Enter: "⏎",
  Tab: "⇥",
  Backspace: "⌫",
  Escape: "esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Meta: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Control: "⌃",
  " ": "␣",
};

/** What a scenario drives: the keyboard, at a human pace, with the overlay. */
class Director {
  /**
   * @param page The recorded page: the keyboard and the key overlay.
   * @param app The frame the app runs in.
   * @param catalog The editor's maths command list, if it could be read.
   */
  constructor(page, app, catalog) {
    this.page = page;
    this.app = app;
    this.catalog = catalog;
    this.inMath = false;
  }

  /** Wait, scaled by --speed. */
  async pause(ms) {
    await sleep(ms / SPEED);
  }

  /** Press one key: a single character, or a Playwright key name. */
  async key(key) {
    const named = [...key].length > 1;
    // Every press gets its own keycap. Named keys are highlighted, and so is
    // a space inside a formula, where it is a command rather than text.
    const special = named || (key === " " && this.inMath);
    const label = key
      .split("+")
      .map((part) => KEY_LABELS[part] ?? part)
      .join(" ");
    await this.page.evaluate(
      ([text, highlighted]) => window.demoOverlay.key(text, highlighted),
      [label, special],
    );
    if (named) await this.page.keyboard.press(key);
    else await this.page.keyboard.type(key);
    await sleep(this.#delayAfter(key, named));
  }

  #delayAfter(key, named) {
    let ms = 62 + Math.random() * 48;
    if (named) ms = 230;
    else if (key === "\\" || key === "$") ms = 170;
    else if (/[\s.,;:!?]/.test(key)) ms *= 1.7;
    return Math.max(14, ms / SPEED);
  }

  /** Type prose, one key at a time. */
  async type(text) {
    for (const ch of text) await this.key(ch);
  }

  /** Press a named key (`Enter`, `Tab`, `Shift+Enter`, …), optionally repeated. */
  async press(key, times = 1) {
    for (let i = 0; i < times; i++) await this.key(key);
  }

  /** New line, with a short breath after it. */
  async enter() {
    await this.key("Enter");
    await this.pause(220);
  }

  /**
   * An inline formula: `$`, the LaTeX as written, `$`. It turns into a formula
   * on the closing dollar. Follow it with a space or punctuation — a letter
   * typed straight after would join the formula.
   */
  async inlineMath(latex) {
    this.inMath = true;
    await this.key("$");
    for (const ch of latex) await this.key(ch);
    await this.key("$");
    this.inMath = false;
    await this.pause(650);
  }

  /**
   * Step back into the inline formula just before the caret, do `steps` there
   * (`math`, `command`, `press`), and step out again. Use it right after
   * `inlineMath`, with nothing typed in between.
   */
  async editMath(steps) {
    await this.key("ArrowLeft");
    this.inMath = true;
    await this.pause(300);
    await steps();
    await this.key("ArrowRight");
    this.inMath = false;
    await this.pause(650);
  }

  /** Type inside a formula, one key at a time. */
  async math(text) {
    for (const ch of text) await this.key(ch);
  }

  /**
   * Insert a command through the editor's LaTeX menu: type `\` and `query`,
   * let the menu show, move to `name` if it is not first, and press Enter.
   * The caret ends in the command's first slot.
   */
  async command(query, name) {
    await this.key("\\");
    for (const ch of query) await this.key(ch);
    await this.pause(900);
    const picked = this.app.locator(
      "[data-radix-popper-content-wrapper] button.bg-accent",
    );
    for (let tries = 0; ; tries++) {
      const label = (await picked.innerText()).trim();
      if (label === `\\${name}`) break;
      if (tries === 8) {
        throw new Error(`\\${name} is not in the menu for "\\${query}".`);
      }
      await this.key("ArrowDown");
      await this.pause(250);
    }
    await this.pause(300);
    await this.key("Enter");
    await this.pause(350);
  }

  /**
   * A display equation, built the way a person builds it: `$$` on an empty
   * line, then commands and slot-to-slot moves. Ends on a new line below.
   */
  async blockMath(latex) {
    const steps = latexToKeys(latex, this.catalog);
    this.inMath = true;
    await this.key("$");
    await this.key("$");
    await this.pause(350);
    for (const step of steps) {
      for (const key of step.keys) await this.key(key);
      // Let a finished command settle before the next keys.
      if (step.keys[0] === "\\") await this.pause(220);
    }
    this.inMath = false;
    await this.pause(900);
    await this.enter();
  }

  /** The whole page as Markdown. Selects everything, so call it last. */
  async markdown() {
    await this.page.keyboard.press("ControlOrMeta+a");
    await this.page.keyboard.press("ControlOrMeta+a");
    await sleep(150);
    return this.app
      .getByRole("textbox", { name: "Text editor" })
      .evaluate((el) => {
        const data = new DataTransfer();
        el.dispatchEvent(
          new ClipboardEvent("copy", {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        );
        const hidden = /<!--tasfer-clipboard:([A-Za-z0-9+/=]+)-->/.exec(
          data.getData("text/html"),
        );
        return hidden
          ? new TextDecoder().decode(
              Uint8Array.from(atob(hidden[1]), (c) => c.charCodeAt(0)),
            )
          : data.getData("text/plain");
      });
  }
}

/**
 * Load the recorded page: the app (at `appUrl`) in a frame, with the key
 * overlay on top. Returns the app's frame.
 */
async function loadShell(page, { width, appUrl }) {
  // Served from the app's own address so the frame is same-origin with it.
  const shellUrl = new URL("/__demo-video-shell", BASE).href;
  await page.route(shellUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: shellHtml({ width, height: HEIGHT, scale: SCALE, appUrl }),
    }),
  );
  await page.goto(shellUrl, { waitUntil: "load" });
  return (await page.waitForSelector("#app")).contentFrame();
}

/**
 * Make a new page in the sidebar's space and wait for it to open. Runs on the
 * app directly, not through the shell.
 */
async function addPage(page) {
  const before = page.url();
  const add = page.getByRole("button", { name: "Add page" }).first();
  if (await add.isVisible()) await add.click();
  else await page.getByRole("button", { name: "Create new page" }).first().click();
  await page.waitForURL(
    (url) => /\/page\/./.test(url.pathname) && url.href !== before,
  );
  await page.locator("canvas").first().waitFor({ state: "visible" });
  await sleep(300);
}

/**
 * Fill the sidebar with titled, coloured pages, so the whole-app picture does
 * not show an empty workspace. Runs on the app directly, before recording.
 */
async function seedSidebar(page, pages) {
  for (const { title, color } of pages) {
    await addPage(page);
    const box = await page.locator("canvas").first().boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 90);
    await page.getByRole("textbox", { name: "Text editor" }).waitFor();
    await page.keyboard.type(title);
    const id = new URL(page.url()).pathname.split("/").pop();
    const row = page.locator(`[data-page-row="${id}"]`).first();
    await row.getByText(title).waitFor();
    if (color) {
      await row.click({ button: "right" });
      await page.getByRole("button", { name: `Select color ${color}` }).click();
      await page.keyboard.press("Escape");
    }
  }
}

/**
 * Whole-app version of {@link openEmptyPage}: set up a named space, fill the
 * sidebar, make the page to type in, then load it in the shell.
 */
async function openEmptyPageInApp(page, sidebar, space) {
  await onboard(page, "Alice", space);
  await seedSidebar(page, sidebar);
  await addPage(page);
  const path = new URL(page.url()).pathname;
  const app = await loadShell(page, {
    width: WIDTH,
    appUrl: new URL(path, BASE).href,
  });
  await framePage(page, app);
  return app;
}

/**
 * Get from a fresh profile to an empty page with the caret in its title, with
 * only the editor canvas in the picture. Returns the app's frame.
 */
async function openEmptyPage(page) {
  const app = await loadShell(page, { width: WIDTH, appUrl: BASE });
  // Clicked through the DOM: in the zoomed page a mouse click aimed at these
  // buttons can land on the dialog backdrop instead.
  await app.getByRole("button", { name: "Skip setup" }).dispatchEvent("click");
  await app
    .getByRole("button", { name: "Create new page" })
    .first()
    .dispatchEvent("click");
  await framePage(page, app);
  return app;
}

/**
 * Frame an open page for the camera and put the caret in the title. Unless
 * the whole app is wanted, hide what floats over the canvas and crop to it.
 */
async function framePage(page, app) {
  const canvas = app.locator("canvas").first();
  await canvas.waitFor({ state: "visible" });
  if (!SHOW_APP) {
    // The Schedule / Add cover row floats over the canvas; keep it out of the
    // picture. The row is two levels above the button.
    await app
      .getByRole("button", { name: "Add cover" })
      .evaluate((button) => {
        button.parentElement.parentElement.style.visibility = "hidden";
      });
  }
  if (SHOW_APP) {
    // The folded "Notes in browser storage" line at the foot of the sidebar:
    // the app cannot dismiss it, so take its strip out of the picture. The
    // strip is two levels above the button.
    await app
      .getByText("Notes in browser storage")
      .evaluate((label) => {
        label.closest("button").parentElement.parentElement.style.display =
          "none";
      });
  }
  if (SHOW_APP) {
    // The "Saving..." / "Saved" note in the top bar comes and goes with every
    // key, which flickers on video. It is rebuilt each time, so hide it
    // whenever it appears.
    await app.evaluate(() => {
      const hide = () => {
        for (const label of document.querySelectorAll("span")) {
          const text = label.textContent;
          if (text === "Saving..." || text === "Saved") {
            label.parentElement.style.display = "none";
          }
        }
      };
      hide();
      new MutationObserver(hide).observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
  }
  await page.evaluate((crop) => {
    window.demoOverlay.adoptTheme();
    if (crop) window.demoOverlay.cropToCanvas();
  }, !SHOW_APP);
  await sleep(300);
  // The title, a little inside the canvas. The mouse works in the recorded
  // page's pixels, which are `scale` times the app's.
  const title = await page.evaluate(() =>
    window.demoOverlay.canvasPoint(160, 90),
  );
  await page.mouse.click(title.x * SCALE, title.y * SCALE);
  await app.getByRole("textbox", { name: "Text editor" }).waitFor();
  await sleep(600);
}

/**
 * Onboard a fresh profile as `name`, with a space of their own. Runs on the
 * app directly, at full size, before anything is recorded.
 */
async function onboard(page, name, space) {
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#loading", { state: "detached" });
  await page.locator(".ob-btn-primary:visible").first().click();
  await page.locator(".ob-input:visible").first().fill(name);
  await page.locator(".ob-btn-primary:visible").first().click();
  if (space) await page.getByPlaceholder("Personal").fill(space);
  await page.getByRole("button", { name: /^Create (new )?space$/ }).click();
  await page.getByRole("button", { name: "Create new page" }).first().waitFor();
}

/**
 * Put every peer on one new page: the first makes it and invites the others
 * into their space. Returns the page's path.
 */
async function shareOnePage([host, ...guests], sidebar) {
  await seedSidebar(host, sidebar);
  await addPage(host);
  const path = new URL(host.url()).pathname;

  for (const guest of guests) {
    await host.getByRole("button", { name: "Space settings" }).first().click();
    await host.getByRole("menuitem", { name: "Invite members" }).click();
    const invite = host.getByRole("dialog");
    // The peer-to-peer explainer, shown once per profile.
    const understood = invite.getByRole("checkbox", { name: /^I understand/ });
    const next = invite.getByRole("button", { name: "Continue" });
    const create = invite.getByRole("button", { name: "Create invite" });
    while (!(await create.isVisible())) {
      if (await understood.isVisible()) {
        if ((await understood.getAttribute("aria-checked")) !== "true") {
          await understood.click();
        }
      }
      if ((await next.isVisible()) && (await next.isEnabled())) {
        await next.click();
      }
      await sleep(400);
    }
    await invite.getByRole("button", { name: "Create invite" }).click();
    await invite.getByRole("button", { name: "Invite Code", exact: true }).click();
    const code = (await invite.locator("code").innerText()).trim();

    await guest.getByRole("button", { name: "Add space" }).first().click();
    const join = guest.getByRole("dialog");
    await join.getByText("Join space", { exact: true }).first().click();
    await join.getByPlaceholder("Paste code here...").fill(code);
    await join.getByRole("button", { name: "Join space" }).click();
    await join
      .getByText(/^Joined ".*" successfully!$/)
      .waitFor({ timeout: 60_000 });
    await join.getByRole("button", { name: "Done" }).click();
    await host.keyboard.press("Escape");
  }

  // The page list arrives before the page itself; until it does, opening the
  // page says "Page not found". Keep opening it until it shows.
  const id = path.split("/").pop();
  for (const guest of guests) {
    const canvas = guest.locator("canvas").first();
    const deadline = Date.now() + 60_000;
    while (!(await canvas.isVisible())) {
      if (Date.now() > deadline) throw new Error("The page never reached a peer.");
      await guest.locator(`[data-page-row="${id}"]`).first().click();
      await canvas.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    }
  }
  return path;
}

/**
 * One fresh profile per peer, all on one shared page, each framed for the
 * camera. Returns `{ name, page, app }` per peer.
 */
async function openSharedPage(
  browser,
  names,
  contextOptions,
  setUp,
  sidebar,
  space,
) {
  const peers = [];
  for (const name of names) {
    const context = await browser.newContext({
      ...contextOptions,
      // The shell is served by intercepting its address; a service worker
      // would answer it first.
      serviceWorkers: "block",
    });
    await setUp(context);
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      console.error(`[${name} page error]`, error.message),
    );
    // Only the first peer's space is shared and seen.
    await onboard(page, name, peers.length ? undefined : space);
    peers.push({ name, page });
  }
  const path = await shareOnePage(
    peers.map((peer) => peer.page),
    sidebar,
  );

  for (const peer of peers) {
    // Every peer types through the shell, recorded or not: it shows the keys.
    peer.app = await loadShell(peer.page, {
      width: WIDTH,
      appUrl: new URL(path, BASE).href,
    });
    await framePage(peer.page, peer.app);
  }
  return peers;
}

/**
 * The editor's maths command list, read from the dev server's own source, so
 * the keystrokes match what this build of the editor does. Returns undefined
 * when the app is not a dev build; the translator then plays it safe.
 */
async function readCommandCatalog(app) {
  const file = join(REPO_ROOT, "packages", "math", "src", "math-commands.ts");
  return app
    .evaluate(async (path) => {
      const mod = await import(/* @vite-ignore */ `/@fs${path}`);
      return mod.MATH_COMMANDS.map(({ id, latex }) => ({ id, latex }));
    }, file)
    .catch(() => undefined);
}

/** Collect the frames Chromium paints, each with the time it was painted. */
async function startCapture(page, dir) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const writes = [];
  cdp.on("Page.screencastFrame", (frame) => {
    const file = join(dir, `f${String(frames.length).padStart(6, "0")}.jpg`);
    frames.push({ file, at: frame.metadata.timestamp });
    writes.push(writeFile(file, Buffer.from(frame.data, "base64")));
    cdp
      .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
      .catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 95,
    everyNthFrame: 1,
  });
  return async () => {
    await cdp.send("Page.stopScreencast");
    await Promise.all(writes);
    return { frames, endedAt: Date.now() / 1000 };
  };
}

/** Frames only arrive when the screen changes, so each one is held until the next. */
function encode(frames, endedAt, dir, outFile) {
  const lines = [];
  frames.forEach((frame, i) => {
    const until = frames[i + 1]?.at ?? Math.max(endedAt, frame.at + 0.5);
    lines.push(`file '${frame.file}'`);
    lines.push(`duration ${Math.max(0.001, until - frame.at).toFixed(4)}`);
  });
  lines.push(`file '${frames.at(-1).file}'`);
  const list = join(dir, "frames.txt");
  writeFileSync(list, lines.join("\n"));
  const result = spawnSync(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", list,
      "-vf", `fps=${FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
      "-c:v", "libx264", "-preset", "slow", "-crf", "18",
      "-movflags", "+faststart",
      outFile,
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw new Error(`Could not run ffmpeg: ${result.error.message}`);
  if (result.status !== 0) throw new Error("ffmpeg failed.");
}

async function main() {
  const scenarioFile = /[\\/]|\.mjs$/.test(scenarioArg)
    ? resolve(scenarioArg)
    : join(HERE, "scenarios", `${scenarioArg}.mjs`);
  const module = await import(pathToFileURL(scenarioFile).href);
  const scenario = module.default;
  const names = module.peers ?? [];
  const sidebar = SHOW_APP ? (module.sidebar ?? SIDEBAR_PAGES) : [];
  const space = SHOW_APP ? (module.space ?? SPACE_NAME) : undefined;
  const name = basename(scenarioFile, ".mjs");

  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: !has("headed") });
  const contextOptions = {
    // Real pixels; the page zooms itself by SCALE (see overlay.mjs).
    viewport: { width: WIDTH * SCALE, height: HEIGHT * SCALE },
    colorScheme: has("dark") ? "dark" : "light",
    locale: "en-US",
    ignoreHTTPSErrors: true,
  };
  // The app's own page settings ("Full width", the serif font), switched on
  // before it loads.
  const pageSettings = (context) =>
    context.addInitScript(
      ([wide, serif, app]) => {
        const set = (key, value) =>
          localStorage.setItem(`pageSettings.${key}`, JSON.stringify(value));
        if (wide) set("editorWidth", "wide");
        if (serif) set("fontStyle", "serif");
        // Fold the "notes are in browser storage" banner down to its chip.
        if (app) localStorage.setItem("storageBannerCollapsed", "1");
      },
      [has("wide"), has("serif"), SHOW_APP],
    );

  const frameDir = mkdtempSync(join(tmpdir(), "tasfer-demo-"));
  try {
    let peers;
    if (names.length) {
      peers = await openSharedPage(
        browser,
        names,
        contextOptions,
        pageSettings,
        sidebar,
        space,
      );
    } else {
      const context = await browser.newContext(contextOptions);
      await pageSettings(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => console.error("[page error]", error.message));
      const app = SHOW_APP
        ? await openEmptyPageInApp(page, sidebar, space)
        : await openEmptyPage(page);
      peers = [{ page, app }];
    }
    const catalog = await readCommandCatalog(peers[0].app);
    if (!catalog) console.warn("No command list from the app; using safe keys.");

    const directors = peers.map(
      ({ page, app }) => new Director(page, app, catalog),
    );
    // Only the first peer's screen is filmed.
    const stop = RECORD ? await startCapture(peers[0].page, frameDir) : null;
    await sleep(500);
    await scenario(
      names.length
        ? Object.fromEntries(
            names.map((peer, n) => [peer.toLowerCase(), directors[n]]),
          )
        : directors[0],
    );
    await sleep(1200);

    if (stop) {
      const { frames, endedAt } = await stop();
      if (!frames.length) throw new Error("The browser sent no frames.");
      mkdirSync(OUT, { recursive: true });
      const suffix = ["canvas", "serif", "dark"]
        .filter(has)
        .map((option) => `-${option}`)
        .join("");
      const outFile = join(OUT, `${name}${suffix}.mp4`);
      encode(frames, endedAt, frameDir, outFile);
      console.log(`${outFile}  (${frames.length} frames)`);
    }
    if (has("check")) {
      // Every peer should end on the same page.
      for (const [n, director] of directors.entries()) {
        if (names.length) console.log(`--- ${names[n]} ---`);
        console.log(await director.markdown());
      }
    }
  } catch (error) {
    if (process.env.DEMO_DEBUG_DIR) {
      for (const [c, context] of browser.contexts().entries()) {
        for (const [n, page] of context.pages().entries()) {
          await page
            .screenshot({ path: join(process.env.DEMO_DEBUG_DIR, `ctx${c}-${n}.png`) })
            .catch(() => {});
          console.error(`ctx${c}-${n}`, page.url());
        }
      }
    }
    throw error;
  } finally {
    await browser.close();
    rmSync(frameDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
