import { clearMock, setMock, sidebar, signInAs } from "./support/demo"
import { expect, test } from "./support/test"
import type { Page } from "@playwright/test"

// The wallet refusing to sign (a cancelled prompt) sends nothing and stops the run there:
// the row offers "Sign again" for the same prepared transaction, which continues the run
// from it, never "Retry", which the service refuses while a payment can still land.

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

test("a cancelled signature stops the run, and signing again continues it from there", async ({
  page,
}) => {
  await startRun(page)

  const bruno = rowOf(page, "Bruno Costa")
  const diego = rowOf(page, "Diego Martins")
  await expect(bruno).toContainText("Not signed")
  await expect(bruno).toContainText("You cancelled the signature.")
  await expect(bruno.getByRole("button", { name: /^Sign again/ })).toBeVisible()
  // Diego's payment waits its turn: nothing was asked of the wallet for it.
  await expect(diego).toContainText("Pending")
  await expect(diego.getByRole("button")).toHaveCount(0)
  const progress = page.getByRole("region", { name: "Payments in this run" })
  await expect(
    progress.getByRole("button", { name: "Retry failed payments" }),
  ).toHaveCount(0)
  await expect(progress.getByRole("status")).toContainText("0 of 2 confirmed")
  await expect(progress).toContainText(
    "The run stopped at a signature you cancelled",
  )
  // Nothing moved.
  await expect(sidebar(page)).toContainText("$84,000.00")

  // The person signs this time: the run goes on to the end.
  await clearMock(page)
  await setMock(page, "instant")
  await bruno.getByRole("button", { name: /^Sign again/ }).click()
  await expect(progress.getByRole("status")).toContainText("2 of 2 confirmed")
  await expect(bruno).toContainText("Confirmed")
  await expect(diego).toContainText("Confirmed")
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
