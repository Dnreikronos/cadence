import { clearMock, setMock, sidebar, signInAs } from "./support/demo"
import { expect, test } from "./support/test"
import type { Page } from "@playwright/test"

// The wallet refusing to sign (a cancelled prompt) sends nothing: the row offers "Sign
// again" for the same prepared transaction, never "Retry", which the service refuses for
// a payment that neither failed nor expired.

async function startRun(page: Page) {
  await signInAs(page, "admin")
  await setMock(page, "instant")
  await page.getByRole("link", { name: "New payroll run" }).first().click()
  await expect(page).toHaveURL("/company/runs/new")
  await page.getByRole("checkbox", { name: /Northwind Audit/ }).uncheck()
  // `sign-cancelled` is a mock scenario of the wallet; the shared helper's list of
  // names is not extended for one spec.
  await page.evaluate(() => {
    window.cadenceMock?.set("instant", "sign-cancelled" as never)
  })
  await page.getByRole("button", { name: /^Pay 2 people/ }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm and sign" })
    .click()
}

const rowOf = (page: Page, name: string) =>
  page
    .getByRole("region", { name: "Payments in this run" })
    .getByRole("listitem")
    .filter({ hasText: name })

test("a cancelled signature is signed again from the same transaction, never retried", async ({
  page,
}) => {
  await startRun(page)

  const bruno = rowOf(page, "Bruno Costa")
  const diego = rowOf(page, "Diego Martins")
  for (const row of [bruno, diego]) {
    await expect(row).toContainText("Not signed")
    await expect(row).toContainText(
      "You cancelled the signature. Nothing was sent.",
    )
    await expect(row.getByRole("button", { name: /^Sign again/ })).toBeVisible()
    await expect(row.getByRole("button", { name: /^Retry/ })).toHaveCount(0)
  }
  const progress = page.getByRole("region", { name: "Payments in this run" })
  await expect(progress.getByRole("status")).toContainText("0 of 2 confirmed")
  await expect(progress.getByRole("status")).toContainText("2 need attention")
  await expect(progress).toContainText("weren't signed, so nothing was sent")
  // Nothing moved.
  await expect(sidebar(page)).toContainText("$84,000.00")

  // The person signs this time.
  await clearMock(page)
  await setMock(page, "instant")
  await bruno.getByRole("button", { name: /^Sign again/ }).click()
  await expect(bruno).toContainText("Confirmed")
  await expect(bruno.getByRole("button")).toHaveCount(0)
  await expect(diego).toContainText("Not signed")

  await diego.getByRole("button", { name: /^Sign again/ }).click()
  await expect(diego).toContainText("Confirmed")
  await expect(progress.getByRole("status")).toContainText("2 of 2 confirmed")
  await expect(progress).toContainText("Every payment is confirmed.")
  // Each person was paid once.
  await expect(sidebar(page)).toContainText("$73,500.00")
})

test("a signature cancelled again stays signable", async ({ page }) => {
  await startRun(page)
  const bruno = rowOf(page, "Bruno Costa")
  await expect(bruno).toContainText("Not signed")

  await bruno.getByRole("button", { name: /^Sign again/ }).click()

  await expect(bruno).toContainText("Not signed")
  await expect(bruno.getByRole("button", { name: /^Sign again/ })).toBeVisible()
  await expect(bruno.getByRole("button", { name: /^Retry/ })).toHaveCount(0)
})
