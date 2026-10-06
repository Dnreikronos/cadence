import { type Page, test as plain } from "@playwright/test"
import { collectCspViolations } from "./support/csp"
import { openScreen, screens } from "./support/screens"
import { expect, test } from "./support/test"

// Every spec fails on a Content-Security-Policy violation (see support/test.ts). These
// check the policy is really being served with a fresh nonce, that it blocks and reports
// what it should, and walk the landing page, a 404 and every main screen asserting there
// are no violations.

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
  expect(directives["script-src"]).toMatch(
    /^'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic'$/,
  )
  expect(directives["require-trusted-types-for"]).toBe("'script'")
  // The e2e build runs the mock: its `default` policy lets MSW's worker register
  // (src/lib/api/mocks/trusted-types.ts). A real build allows Next's policy only.
  expect(directives["trusted-types"]).toBe("nextjs#bundler default")
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

const nonceOf = (policy: string) => policy.match(/'nonce-([^']+)'/)![1]

test("every response has a nonce of its own, on every script it renders", async ({
  page,
}) => {
  const nonces = new Set<string>()
  for (const path of [
    "/",
    "/sign-in",
    "/sign-in",
    "/company",
    "/no-such-page",
  ]) {
    const response = await page.request.get(path)
    const nonce = nonceOf(response.headers()["content-security-policy"])
    nonces.add(nonce)
    const tags = (await response.text()).match(/<script\b[^>]*>/g) ?? []
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`)
  }
  expect(nonces.size).toBe(5)
})

// Outside the watched `test`: they provoke a violation on purpose, which the watch would
// (rightly) fail on, and the console error that Chrome also logs for it. The page is of
// the app's origin and carries the policy the app serves; it is made here because
// Playwright's own `evaluate` and `addScriptTag` run unconstrained.
async function canary(page: Page, body: (nonce: string) => string) {
  const policy = (await page.request.get("/sign-in")).headers()[
    "content-security-policy"
  ]
  await page.route("**/csp-canary", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: { "content-security-policy": policy },
      body: `<!doctype html>${body(nonceOf(policy))}`,
    }),
  )
  await page.goto("/csp-canary")
}

plain(
  "the policy reports an eval the page provokes (so silence means none)",
  async ({ context, page }) => {
    const violations = await collectCspViolations(context)
    // A script with the policy's nonce (which the policy allows) trying `eval` (which it
    // does not).
    await canary(
      page,
      (nonce) =>
        `<script nonce="${nonce}">try { new Function('return 1') } catch {}</script>`,
    )

    await expect.poll(() => violations.length).toBe(1)
    expect(violations[0]).toMatch(/^(script-src|require-trusted-types-for)/)
  },
)

plain(
  "the policy blocks an inline script without the nonce, and a wrong one",
  async ({ context, page }) => {
    const violations = await collectCspViolations(context)
    await canary(
      page,
      () =>
        "<script>document.title = 'ran'</script>" +
        "<script nonce=\"bm90LXRoZS1ub25jZQ==\">document.title = 'ran'</script>",
    )

    await expect.poll(() => violations.length).toBe(2)
    for (const violation of violations) expect(violation).toMatch(/^script-src/)
    expect(await page.title()).not.toBe("ran")
  },
)

plain(
  "Trusted Types refuse a string where a script sink wants a typed value",
  async ({ context, page }) => {
    const violations = await collectCspViolations(context)
    await canary(
      page,
      (nonce) =>
        `<div id="d"></div><script nonce="${nonce}">` +
        "try { d.innerHTML = '<b>x</b>' } catch {}</script>",
    )

    await expect.poll(() => violations.length).toBe(1)
    expect(violations[0]).toMatch(/^require-trusted-types-for/)
  },
)

test("a page that does not exist has no violation", async ({ page, watch }) => {
  watch.allowStatus(404, /\/no-such-page$/)
  await page.goto("/no-such-page")
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await page.waitForLoadState("networkidle")

  expect(watch.cspViolations).toEqual([])
})

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
