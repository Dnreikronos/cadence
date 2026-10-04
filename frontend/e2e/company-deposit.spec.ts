import { clearMock, navLink, setMock, sidebar, signInAs } from "./support/demo"
import { expect, test } from "./support/test"
import type { Page } from "@playwright/test"

// The mock company holds $84,000.00 private and $12,500.00 public USDC.
async function openDeposit(page: Page) {
  await signInAs(page, "admin")
  // Client-side navigation: a full load would reset the mock scenarios.
  await setMock(page, "instant")
  await navLink(page, "Deposit").click()
  await expect(page).toHaveURL("/company/deposit")
  await expect(
    page.getByRole("heading", { name: "Make it private" }),
  ).toBeVisible()
  const section = page.getByRole("region", { name: "Make it private" })
  await expect(section).toContainText("$12,500.00")
  return section
}

test("making USDC private moves the balances and updates the sidebar", async ({
  page,
}) => {
  const section = await openDeposit(page)
  await expect(sidebar(page)).toContainText("$84,000.00")

  await section.getByLabel("Amount to make private (USDC)").fill("1000")
  await section.getByRole("button", { name: "Make private" }).click()

  await expect(section.getByRole("status")).toContainText(
    "is now in your private balance",
  )
  await expect(sidebar(page)).toContainText("$85,000.00")
  await expect(section).toContainText("$11,500.00")
  await expect(section).toContainText("$85,000.00")
  await expect(section.getByLabel("Amount to make private (USDC)")).toHaveValue(
    "",
  )
})

test("asks for a valid amount before sending anything", async ({ page }) => {
  const section = await openDeposit(page)

  await section.getByLabel("Amount to make private (USDC)").fill("99999")
  await section.getByRole("button", { name: "Make private" }).click()

  await expect(section.getByRole("alert")).toHaveText(
    "That is more public USDC than you hold",
  )
  // Had a deposit gone out anyway, one of these would have moved.
  await expect(section).toContainText("$12,500.00")
  await expect(section).toContainText("$84,000.00")
  await expect(sidebar(page)).toContainText("$84,000.00")
  await expect(section.getByRole("status")).toBeEmpty()
})

test("a failed transaction can be retried", async ({ page, watch }) => {
  watch.allowStatus(409, /\/wrap\/confirm$/)
  const section = await openDeposit(page)
  await setMock(page, "instant", "tx-failed")

  await section.getByLabel("Amount to make private (USDC)").fill("1000")
  await section.getByRole("button", { name: "Make private" }).click()

  const alert = section.getByRole("alert")
  await expect(alert).toBeVisible()
  await expect(alert).toContainText("Try again")
  // Nothing moved.
  await expect(sidebar(page)).toContainText("$84,000.00")

  await clearMock(page)
  await setMock(page, "instant")
  await alert.getByRole("button", { name: "Try again" }).click()

  await expect(section.getByRole("status")).toContainText(
    "is now in your private balance",
  )
  await expect(sidebar(page)).toContainText("$85,000.00")
})

test("an unactivated company wallet is told so, and nothing is deposited", async ({
  page,
  watch,
}) => {
  watch.allowStatus(409, /\/wrap$/)
  const section = await openDeposit(page)
  await setMock(page, "instant", "setup-required")

  await section.getByLabel("Amount to make private (USDC)").fill("1000")
  await section.getByRole("button", { name: "Make private" }).click()

  await expect(
    section.getByText("Your wallet needs activating first"),
  ).toBeVisible()
  await expect(section.getByText("nothing was deposited")).toBeVisible()
  await expect(section.getByRole("button", { name: "Try again" })).toHaveCount(
    0,
  )
  await expect(sidebar(page)).toContainText("$84,000.00")
})

test("a payment that arrived mid-flight leaves the deposit waiting, and trying again finishes it", async ({
  page,
  watch,
}) => {
  watch.allowStatus(409, /\/accounts\/apply-pending\/confirm$/)
  const section = await openDeposit(page)
  await setMock(page, "instant", "credit-mismatch")

  await section.getByLabel("Amount to make private (USDC)").fill("1000")
  await section.getByRole("button", { name: "Make private" }).click()

  // The deposit itself went through; making it available is what failed, and the screen
  // says so instead of offering the deposit again.
  const alert = section.getByRole("alert")
  await expect(alert).toContainText(
    "A payment arrived while we were updating your balance. Try again.",
  )
  await expect(alert).toContainText("The deposit went through.")
  await expect(alert).toContainText("trying again only finishes that.")
  await expect(section).toContainText("$11,500.00")
  await expect(sidebar(page)).toContainText("$84,000.00")
  // The amount is not left in the field to be sent twice.
  await expect(section.getByLabel("Amount to make private (USDC)")).toHaveValue(
    "",
  )

  await clearMock(page)
  await setMock(page, "instant")
  await alert.getByRole("button", { name: "Try again" }).click()

  await expect(section.getByRole("status")).toContainText(
    "is now in your private balance",
  )
  await expect(sidebar(page)).toContainText("$85,000.00")
  // Nothing was wrapped a second time.
  await expect(section).toContainText("$11,500.00")
})
