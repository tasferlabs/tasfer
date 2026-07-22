---
name: run-web
description: Build, launch, drive, and screenshot the Tasfer web app — the canvas-native editor product. Use to run/start the dev server, take a screenshot, or confirm an editor/UI change works in the real running app (not just tests). Drives the app with Playwright + a committed driver.
---

# Run the Tasfer web app

The main Tasfer product is a Vite + React host that renders
the editor to **HTML `<canvas>`**. It's a plain web app served on
**http://localhost:4000**. Drive it with the Playwright driver at
`.claude/skills/run-web/driver.mjs` — screenshots are the only reliable way to
observe the canvas.

Paths below are relative to the **app root** — the directory that contains this skill under `.claude/skills/run-web/`.

## Prerequisites

- Node 22+.
- A Chromium for Playwright. If it's not cached, run once:
  `cd .claude/skills/run-web && npx playwright install chromium`.

## Running

```bash
# One screenshot of an open editor:
node driver.mjs shot /tmp/tasfer.png

# Run JS in the page and print the result:
node driver.mjs eval "document.querySelectorAll('canvas').length"

# Staged screenshots of the full cold flow (onboarding → editor → typed text):
node driver.mjs smoke --out /tmp/tasfer-smoke
```

Then **look at the PNGs** — that's how you verify a canvas change. Add
`--headed` to watch a real window.

## Gotchas

- **The document is a `<canvas>` — DOM automation can't see its text.** No
  selector will match typed content. Assert with screenshots, not `getByText`.
  There are **two** `<canvas>` elements when a page is open.
- **No page → no canvas.** After onboarding you land on a "No pages found"
  space home; the editor only mounts once a page is open. The driver clicks
  **Create new page**; if you script your own flow, do the same.
- **Onboarding gates the whole app** (`Layout` renders `<OnboardingScreen />`
  when `spaces.length === 0`). The persistent profile is what lets the driver
  skip it after the first run; a `--fresh`/incognito context always re-onboards
  because it has no stored space.
- **The first block is an H1** (placeholder "Heading 1"), so the first line you
  type renders large. Press Enter for body text.
- **Port 4000 in use → Vite silently moves to 4001.** Reuse the running server
  (curl check above) instead of starting another. Kill strays with
  `pkill -f vite` (or `lsof -ti :4000 | xargs kill`).
- **`dev:host` (`vite --host`) needs an mkcert TLS cert** in the app's `certs/`;
  without it the LAN origin is an insecure context and crypto/OPFS break. For
  local driving just use plain `npm run dev` (localhost is already secure).

## PWA manifest screenshots

`seed-shoot.mjs` reseeds the profile's space with showcase content (colored
pages, math, todos) through the app's own markdown importer, then captures the
four screenshots `scripts/gen-manifest.mjs` references:

```bash
node seed-shoot.mjs --publish   # writes into ../../../public/screenshots/
```

Shots land in `/tmp/tasfer-pwa-shots` (override with `--out`); `--publish`
copies the canonical four into `public/screenshots/`. It wipes and reseeds the
`.pw-profile` space — `driver.mjs reset` restores the cold onboarding flow.

## Troubleshooting

- **Driver: "never reached the editor canvas"** — the dev server isn't up (or is
  on 4001), or onboarding changed. Confirm `curl localhost:4000` → 200, then
  run `node driver.mjs smoke --headed` and watch which step stalls. Or we are
  using https the user might run dev:host.
- **Driver hangs / "SingletonLock" / profile busy** — a previous run (or a
  `--headed` window) still holds `.pw-profile`. Close it, or
  `node driver.mjs reset` and retry. Only one process can use the profile at a time.
- **`Executable doesn't exist … ms-playwright`** — run
  `npx playwright install chromium` in `.claude/skills/run-web/`.
