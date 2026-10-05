import type { Page } from "@playwright/test"
import { setMock, signInAs } from "./support/demo"
import { expect, test } from "./support/test"

// Focus never falls to the page when a control goes away: after a hold is released, or an
// export is made, a keyboard user is still somewhere they can carry on from. Everything
// here is done with the keyboard.

const withdrawCard = (page: Page) =>
  page.getByRole("region", { name: "Withdraw to your wallet" })
const amountField = (page: Page) =>
  withdrawCard(page).getByLabel("Amount to withdraw (USDC)")

// A withdrawal that was sent and cannot be settled, and is old enough to be released: it is
// sent in a tab that is then reloaded (the mock is empty afterwards, so its signature is
// not found, which says nothing), and its record is made three minutes older.
async function holdAWithdrawal(page: Page) {
  page.on("dialog", (dialog) => void dialog.accept())
  await signInAs(page, "recipient")
  await page.goto("/me/withdraw?mock=slow")
  const card = withdrawCard(page)
  await expect(card).toContainText("$8,000.00")
  await amountField(page).fill("1234.56")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(window.localStorage).filter((key) =>
            key.startsWith("cadence:submissions:withdraw:"),
          ).length,
      ),
    )
    .toBe(1)
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (!key.startsWith("cadence:submissions:withdraw:")) continue
      const records = JSON.parse(window.localStorage.getItem(key) ?? "[]")
      for (const record of records) record.at -= 3 * 60_000
      window.localStorage.setItem(key, JSON.stringify(records))
    }
  })
  await page.reload()
  await expect(
    card.getByText("The withdrawal may have gone through"),
  ).toBeVisible()
}

test("releasing a withdrawal keeps focus on the page at every step", async ({
  page,
  watch,
}) => {
  test.setTimeout(60_000)
  watch.allowStatus(404, /\/unwrap\/confirm$/)
  watch.allowStatus(409, /\/unwrap\/confirm$/)
  await holdAWithdrawal(page)
  const card = withdrawCard(page)

  const open = card.getByRole("button", {
    name: "I checked my history, release this amount",
  })
  await expect(open).toBeVisible()
  await open.focus()
  await page.keyboard.press("Enter")
  // The confirmation takes focus, so its warning is read first and nothing is one key from done.
  const confirmation = card.getByRole("group", { name: "Release $1,234.56" })
  await expect(confirmation).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(
    card.getByRole("button", { name: "Release $1,234.56" }),
  ).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(card.getByRole("button", { name: "Keep it held" })).toBeFocused()

  // Keeping it held returns to where it was opened.
  await page.keyboard.press("Enter")
  await expect(open).toBeFocused()
  await expect(confirmation).toHaveCount(0)

  // Releasing it removes the whole notice: focus goes to the amount field, ready for the next.
  await page.keyboard.press("Enter")
  await expect(confirmation).toBeFocused()
  await page.keyboard.press("Tab")
  await page.keyboard.press("Enter")
  await expect(
    card.getByText("The withdrawal may have gone through"),
  ).toHaveCount(0)
  await expect(amountField(page)).toBeFocused()
})

test("releasing what could not be read keeps focus on the page too", async ({
  page,
  watch,
}) => {
  test.setTimeout(60_000)
  watch.allowStatus(404, /\/unwrap\/confirm$/)
  watch.allowStatus(409, /\/unwrap\/confirm$/)
  await holdAWithdrawal(page)
  // What is saved can no longer be read.
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith("cadence:submissions:withdraw:")) {
        window.localStorage.setItem(key, "not json")
      }
    }
  })
  await page.reload()
  const card = withdrawCard(page)
  await expect(card.getByRole("alert")).toContainText("Unreadable saved state")

  const open = card.getByRole("button", {
    name: "I checked my history, release this saved state",
  })
  await open.focus()
  await page.keyboard.press("Enter")
  await expect(
    card.getByRole("group", { name: "Release unreadable state" }),
  ).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(
    card.getByRole("button", { name: "Release unreadable state" }),
  ).toBeFocused()
  await page.keyboard.press("Enter")

  await expect(card.getByText("Unreadable saved state")).toHaveCount(0)
  await expect(amountField(page)).toBeFocused()
})

test("releasing a person from a payroll hold keeps focus on the page", async ({
  page,
  watch,
}) => {
  test.setTimeout(60_000)
  watch.allowStatus(404, /\/runs\/[^/]+\/payments\/[^/]+\/confirm$/)
  watch.allowStatus(409, /\/runs\/[^/]+\/payments\/[^/]+\/confirm$/)
  page.on("dialog", (dialog) => void dialog.accept())

  await signInAs(page, "admin")
  await page.goto("/company/runs/new")
  await expect(
    page.getByRole("checkbox", { name: /Bruno Costa/ }),
  ).toBeVisible()
  // Without a scenario the network takes a few seconds to confirm: time to reload in.
  await setMock(page)
  await page.getByRole("checkbox", { name: /Diego Martins/ }).uncheck()
  await page.getByRole("checkbox", { name: /Northwind Audit/ }).uncheck()
  await page.getByRole("button", { name: /^Pay 1 person/ }).click()
  await page
    .getByRole("dialog", { name: "Pay 1 person · $4,200.00" })
    .getByRole("button", { name: "Confirm and sign" })
    .click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(window.localStorage).filter((key) =>
            key.startsWith("cadence:submissions:payroll-payment:"),
          ).length,
      ),
    )
    .toBe(1)
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (!key.startsWith("cadence:submissions:payroll-payment:")) continue
      const records = JSON.parse(window.localStorage.getItem(key) ?? "[]")
      for (const record of records) record.at -= 3 * 60_000
      window.localStorage.setItem(key, JSON.stringify(records))
    }
  })
  await page.reload()

  const checking = page.getByRole("region", {
    name: "Last payment not settled (1)",
  })
  const open = checking.getByRole("button", { name: "Release this person" })
  await expect(open).toBeVisible()
  await open.focus()
  await page.keyboard.press("Enter")
  const confirmation = checking.getByRole("group", {
    name: "Release Bruno Costa",
  })
  await expect(confirmation).toBeFocused()
  await page.keyboard.press("Tab")
  await page.keyboard.press("Tab")
  await expect(
    checking.getByRole("button", { name: "Keep it held" }),
  ).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(open).toBeFocused()

  // Releasing removes the notice, and the main area takes focus.
  await page.keyboard.press("Enter")
  await page.keyboard.press("Tab")
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { name: "Last payment not settled (1)" }),
  ).toHaveCount(0)
  await expect(page.getByRole("main")).toBeFocused()
})

test.describe("exporting", () => {
  test("the recipient's export keeps focus on its button", async ({ page }) => {
    await signInAs(page, "recipient")
    await page.goto("/me/history")
    const button = page.getByRole("button", { name: "Export CSV" })
    await expect(button).toBeVisible()
    await button.focus()

    const download = page.waitForEvent("download")
    await page.keyboard.press("Enter")
    await download

    await expect(button).toBeFocused()
    // Pressing it again while it works does not start another or move focus.
    await expect(page.getByRole("button", { name: "Export CSV" })).toBeFocused()
  })

  test("the company's export keeps focus on its button", async ({ page }) => {
    await signInAs(page, "admin")
    await page.goto("/company/receipts")
    const button = page.getByRole("button", { name: "Export CSV" })
    await expect(page.getByText("4 payments")).toBeVisible()
    await button.focus()

    const download = page.waitForEvent("download")
    await page.keyboard.press("Enter")
    await download

    await expect(button).toBeFocused()
  })

  test("while it works the button stays focused and does not start a second export", async ({
    page,
  }) => {
    let exports = 0
    page.on("request", (request) => {
      if (request.url().endsWith("/me/export.csv")) exports += 1
    })
    await signInAs(page, "recipient")
    await page.goto("/me/history?mock=slow")
    const button = page.getByRole("button", { name: "Export CSV" })
    await expect(button).toBeVisible()
    await button.focus()

    const download = page.waitForEvent("download")
    await page.keyboard.press("Enter")
    const working = page.getByRole("button", { name: "Exporting…" })
    await expect(working).toBeFocused()
    await expect(working).toHaveAttribute("aria-disabled", "true")
    await page.keyboard.press("Enter")
    await download

    await expect(button).toBeFocused()
    expect(exports).toBe(1)
  })
})
