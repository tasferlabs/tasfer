import { defineConfig } from "@playwright/test";

// End-to-end tests drive the real app in a real browser. They start their own
// dev server on a port of their own, so a `npm run dev` you already have open
// on :4000 is left alone.
const PORT = Number(process.env.E2E_PORT) || 4319;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Output goes to Playwright's default folders (test-results/ and
  // playwright-report/). Keep it that way: the dev server ignores those two, and
  // anything written elsewhere under apps/web makes the app reload mid-test.
  reporter: [[process.env.CI ? "github" : "list"], ["html", { open: "never" }]],
  // The first page load makes Vite pre-bundle dependencies, which is slow once.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    // Tests match English UI text; pin the language so a machine set to Arabic
    // runs the same tests.
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // No `devices["Desktop Chrome"]` here on purpose: that preset claims to be
  // Windows, so on a Mac the app would wait for Ctrl while the tests press Cmd.
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    // The microfrontends plugin pins the dev port to 4000 and ignores `--port`;
    // MFE_APP_PORT is its own override. `--strictPort` makes a busy port an
    // error instead of a silent move to another port the tests would miss.
    command: "npm run dev -- --strictPort",
    env: { MFE_APP_PORT: String(PORT), PORT: String(PORT) },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
