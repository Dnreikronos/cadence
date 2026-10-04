import { existsSync, readFileSync } from "node:fs"
import { defineConfig, devices } from "@playwright/test"
import { demoEnv, markerFile, markerFor } from "./e2e/support/demo-env.cjs"

// A fixed port and a `*.localhost` host that no other local server uses: the demo
// cookie belongs to the host (not the port), so it must never be shared with a dev
// server on `localhost`. Chrome resolves every `*.localhost` name to the loopback.
const PORT = 3300
const baseURL = `http://e2e.localhost:${PORT}`

const CI = !!process.env.CI
const chromePath = process.env.PLAYWRIGHT_CHROME_PATH
const systemChrome = existsSync("/usr/bin/google-chrome-stable")

// Google Chrome when it is installed (always on the CI runner), otherwise the browser
// Playwright downloads with `pnpm exec playwright install chromium`.
const browser = chromePath
  ? { launchOptions: { executablePath: chromePath } }
  : CI || systemChrome
    ? { channel: "chrome" as const }
    : {}

// `next start` serves a production build. It is not bound to the loopback with `--hostname`:
// Next then builds its redirect URLs on that name, so a guarded route would send the
// browser from `e2e.localhost` to `localhost` and the demo cookie with it. `E2E_SKIP_BUILD=1` reuses
// the build already in `.next` (CI builds in its own step with `pnpm e2e:build`, and the
// build is the slow part of a local rerun) but only one that `pnpm e2e:build` made: a
// plain `pnpm build`, or one with Supabase configured, is not the demo.
const serve = `pnpm exec next start --port ${PORT}`

function assertDemoBuild() {
  let marker: unknown
  try {
    marker = JSON.parse(readFileSync(markerFile, "utf8"))
  } catch {
    marker = undefined
  }
  if (JSON.stringify(marker) !== JSON.stringify(markerFor(demoEnv))) {
    throw new Error(
      "E2E_SKIP_BUILD=1, but .next was not built by `pnpm e2e:build` in demo mode " +
        "(mock API, no Supabase). Run `pnpm e2e:build`, or drop E2E_SKIP_BUILD to build and serve.",
    )
  }
}
if (process.env.E2E_SKIP_BUILD) assertDemoBuild()

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: CI,
  // The retry exists to record a trace, not to hide a flaky test: one that only passes
  // on the retry still fails the run.
  retries: CI ? 1 : 0,
  failOnFlakyTests: CI,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    ...browser,
    baseURL,
    viewport: { width: 1280, height: 800 },
    // Dates on screen follow the viewer's time zone: pin it so a test's expected text
    // does not depend on the machine.
    locale: "en-US",
    timezoneId: "UTC",
    // Dialogs and drawers animate in: with reduced motion they are in place at once, so a
    // check never reads one mid-transition. One accessibility test runs with motion on.
    reducedMotion: "reduce",
    trace: "on-first-retry",
  },
  // Every test gets a fresh browser context (Playwright's default), so demo cookies and
  // the in-page mock never leak from one test to the next.
  projects: [{ name: "chromium" }],
  webServer: {
    command: process.env.E2E_SKIP_BUILD ? serve : `pnpm e2e:build && ${serve}`,
    // The readiness probe is Node's, not Chrome's: use the numeric address.
    url: `http://127.0.0.1:${PORT}/sign-in`,
    reuseExistingServer: !!process.env.E2E_REUSE_SERVER,
    timeout: 240_000,
    env: demoEnv,
  },
})
