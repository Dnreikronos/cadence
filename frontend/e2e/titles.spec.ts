import { freshRecipient, signInAs, type Role } from "./support/demo"
import { expect, test } from "./support/test"

// Every screen names itself in the tab (and so in the history and in what a screen reader
// says on arriving), and an address no page answers is a real 404, not a 200 that says so.

const pages: { role: Role | null; path: string; title: string }[] = [
  { role: null, path: "/", title: "Cadence" },
  { role: null, path: "/sign-in", title: "Sign in · Cadence" },
  { role: null, path: "/sign-up", title: "Create your company · Cadence" },
  { role: "admin", path: "/company", title: "Payments · Cadence" },
  { role: "admin", path: "/company/people", title: "People · Cadence" },
  { role: "admin", path: "/company/deposit", title: "Deposit · Cadence" },
  { role: "admin", path: "/company/receipts", title: "Receipts · Cadence" },
  { role: "admin", path: "/company/auditors", title: "Auditors · Cadence" },
  {
    role: "admin",
    path: "/company/runs/new",
    title: "New payroll run · Cadence",
  },
  { role: "recipient", path: "/me", title: "Your balance · Cadence" },
  { role: "recipient", path: "/me/history", title: "History · Cadence" },
  { role: "recipient", path: "/me/withdraw", title: "Withdraw · Cadence" },
  { role: "auditor", path: "/audit", title: "Payments · Cadence" },
  { role: "auditor", path: "/audit/access-log", title: "Access log · Cadence" },
]

for (const { role, path, title } of pages) {
  test(`${path} is titled "${title}"`, async ({ page }) => {
    if (role) await signInAs(page, role)
    await page.goto(path)
    await expect(page).toHaveTitle(title)
  })
}

test("the set-up screen is titled too", async ({ page }) => {
  await freshRecipient(page)
  await expect(page).toHaveTitle("Set up your account · Cadence")
})

test("a title survives moving between screens on the client", async ({
  page,
}) => {
  await signInAs(page, "admin")
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "People", exact: true })
    .click()
  await expect(page).toHaveTitle("People · Cadence")
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Deposit", exact: true })
    .click()
  await expect(page).toHaveTitle("Deposit · Cadence")
})

const unknown: { role: Role | null; path: string }[] = [
  { role: null, path: "/nope" },
  { role: "admin", path: "/company/nope" },
  { role: "admin", path: "/company/people/nope" },
  { role: "recipient", path: "/me/nope" },
  { role: "recipient", path: "/me/history/x" },
  { role: "recipient", path: "/me/withdraw/x" },
  { role: "auditor", path: "/audit/nope" },
]

for (const { role, path } of unknown) {
  test(`${path} is a 404 with the not-found page`, async ({ page, watch }) => {
    // The 404 is the point: the browser logs it as a failed load.
    watch.allowStatus(404, new RegExp(`${path}$`))
    if (role) await signInAs(page, role)
    const response = await page.goto(path)

    expect(response?.status()).toBe(404)
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible()
    await expect(page).toHaveTitle("Page not found · Cadence")
    // Inside the shell, so the way back is the navigation that is already there.
    if (role) {
      await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible()
    }
  })
}

test("a page that is not found on the client does not keep the title of the page before", async ({
  page,
  watch,
}) => {
  watch.allowStatus(404, /\/company\/runs\/abc/)
  await signInAs(page, "admin")
  await page.goto("/company/people")
  await expect(page).toHaveTitle("People · Cadence")

  await page.evaluate(() => {
    ;(
      window as unknown as { next: { router: { push: (to: string) => void } } }
    ).next.router.push("/company/runs/abc")
  })

  await expect(page.getByText("Run not found")).toBeVisible()
  await expect(page).toHaveTitle("Page not found · Cadence")
  // And the next page names itself again.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Deposit", exact: true })
    .click()
  await expect(page).toHaveTitle("Deposit · Cadence")
})
