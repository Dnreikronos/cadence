import { test as plain } from "@playwright/test"
import { collectCspViolations } from "./support/csp"
import { openScreen, screens } from "./support/screens"
import { expect, test } from "./support/test"

// Every spec fails on a Content-Security-Policy violation (see support/test.ts). These
// check the policy is really being served, that it can see a violation at all, and walk
// the landing page and every main screen asserting there are none.

test("the production build serves the policy and the hardening headers", async ({
  page,
}) => {
  const response = await page.goto("/sign-in")
  const headers = response!.headers()

  const policy = headers["content-security-policy"]
  const directives = Object.fromEntries(
    policy.split("; ").map((part) => {
      const [name, ...value] = part.split(" ")
      return [name, value.join(" ")]
    }),
  )
  expect(directives["default-src"]).toBe("'self'")
  expect(directives["script-src"]).toBe("'self' 'unsafe-inline'")
  expect(directives["object-src"]).toBe("'none'")
  expect(directives["frame-ancestors"]).toBe("'none'")
  expect(directives["connect-src"]).toContain("https://api.turnkey.com")
  expect(policy).not.toContain("unsafe-eval")
  expect(headers["x-frame-options"]).toBe("DENY")
  expect(headers["referrer-policy"]).toBe("same-origin")
  expect(headers["x-content-type-options"]).toBe("nosniff")
  expect(headers["permissions-policy"]).toContain("camera=()")
  expect(headers["x-powered-by"]).toBeUndefined()
})

// Outside the watched `test`: it provokes a violation on purpose, which the watch would
// (rightly) fail on, and the console error that Chrome also logs for it.
plain(
  "the policy reports a violation the page provokes (so silence means none)",
  async ({ context, page }) => {
    const violations = await collectCspViolations(context)
    // A page of the app's origin that carries the policy the app serves and an inline
    // script (which the policy allows) trying `eval` (which it does not). It is made here
    // because Playwright's own `evaluate` and `addScriptTag` run unconstrained.
    const policy = (await page.request.get("/sign-in")).headers()[
      "content-security-policy"
    ]
    await page.route("**/csp-canary", (route) =>
      route.fulfill({
        contentType: "text/html",
        headers: { "content-security-policy": policy },
        body: "<!doctype html><script>try { new Function('return 1') } catch {}</script>",
      }),
    )
    await page.goto("/csp-canary")

    await expect.poll(() => violations.length).toBe(1)
    expect(violations[0]).toMatch(/^script-src/)
  },
)

test("the landing page, scrolled to the end, has no violation", async ({
  page,
  watch,
}) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  // The three.js canvas and the scroll-driven sections load as each comes into view.
  for (const section of await page.locator("section").all()) {
    await section.scrollIntoViewIfNeeded()
  }
  await page.waitForLoadState("networkidle")

  expect(watch.cspViolations).toEqual([])
})

for (const screen of screens) {
  test(`${screen.name} has no violation`, async ({ page, watch }) => {
    await openScreen(page, screen)
    await page.waitForLoadState("networkidle")

    expect(watch.cspViolations).toEqual([])
  })
}
