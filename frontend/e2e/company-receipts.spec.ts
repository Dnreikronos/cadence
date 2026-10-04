import { expectPaymentsCsv, readDownload } from "./support/csv"
import { navLink, signInAs } from "./support/demo"
import { expect, test } from "./support/test"
import type { Page } from "@playwright/test"

// Four confirmed payments in the seed: Bruno twice, Diego and Northwind once.
const row = (page: Page, name: string) =>
  page.getByRole("row").filter({ hasText: name })

const count = (page: Page) =>
  page
    .getByRole("main")
    .getByText(/^(\d+ of )?\d+ (loaded )?payments?( loaded)?$/)

test.beforeEach(async ({ page }) => {
  await signInAs(page, "admin")
  await navLink(page, "Receipts").click()
  await expect(page.getByRole("heading", { name: "Receipts" })).toBeVisible()
  await expect(count(page)).toHaveText("4 payments")
})

test("lists every payment with its amount and status", async ({ page }) => {
  await expect(page.getByRole("table", { name: "Payments" })).toBeVisible()
  await expect(row(page, "Northwind Audit")).toContainText("$9,500.00")
  await expect(row(page, "Northwind Audit")).toContainText("Confirmed")
  await expect(row(page, "Diego Martins")).toContainText("$6,300.00")
  await expect(row(page, "Bruno Costa")).toHaveCount(2)
})

test("filters by name and by status", async ({ page }) => {
  await page.getByLabel("Search by name").fill("bruno")
  await expect(count(page)).toHaveText("2 of 4 loaded payments")
  await expect(row(page, "Bruno Costa")).toHaveCount(2)
  await expect(row(page, "Diego Martins")).toHaveCount(0)

  await page.getByLabel("Status").selectOption("failed")
  await expect(page.getByText("No payments match")).toBeVisible()

  await page.getByRole("button", { name: "Clear filters" }).click()
  await expect(count(page)).toHaveText("4 payments")
  await expect(page.getByLabel("Search by name")).toHaveValue("")
  await expect(page.getByLabel("Search by name")).toBeFocused()
})

test("opens the receipt of a payment, and closes it", async ({ page }) => {
  await page
    .getByRole("button", { name: "Receipt for Diego Martins, Sep 1, 2026" })
    .click()

  const dialog = page.getByRole("dialog", { name: "Payment receipt" })
  await expect(dialog).toBeVisible()
  const receipt = dialog.getByRole("article", { name: "Payment receipt" })
  await expect(receipt).toContainText("$6,300.00")
  await expect(receipt).toContainText("6300 USDC")
  await expect(receipt).toContainText("Paid to")
  await expect(receipt).toContainText("Diego Martins")
  await expect(receipt).toContainText("Confirmed")
  await expect(
    receipt.getByRole("link", { name: /View on Solana Explorer/ }),
  ).toHaveAttribute("href", /explorer\.solana\.com\/tx\/.+cluster=devnet/)

  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click()
  await expect(dialog).toBeHidden()
})

test("exports a CSV that holds only the documented columns", async ({
  page,
}) => {
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Export CSV" }).click()

  const { filename, text } = await readDownload(await download)

  expect(filename).toMatch(/^cadence-payments-\d{4}-\d{2}-\d{2}\.csv$/)
  const rows = expectPaymentsCsv(text, 4)
  const payments = rows
    .slice(1)
    .map(([, name, amount]) => `${name} ${Number(amount)}`)
  expect(payments.sort()).toEqual([
    "Bruno Costa 3800",
    "Bruno Costa 4200",
    "Diego Martins 6300",
    "Northwind Audit 9500",
  ])
})

test("Download receipt prints under the receipt's name, then puts the page title back", async ({
  page,
}) => {
  // The print dialog is the browser's: stand in for it and record the title it was given.
  await page.evaluate(() => {
    window.print = () => {
      ;(window as unknown as { printedAs: string }).printedAs = document.title
    }
  })
  const original = await page.title()
  expect(original).not.toBe("")
  await page
    .getByRole("button", { name: "Receipt for Diego Martins, Sep 1, 2026" })
    .click()

  await page
    .getByRole("dialog", { name: "Payment receipt" })
    .getByRole("button", { name: "Download receipt" })
    .click()

  const receiptName = "Cadence receipt 2026-09-01 Diego Martins"
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { printedAs?: string }).printedAs,
      ),
    )
    .toBe(receiptName)
  // Still the receipt's name while the browser is printing, and the old title after it.
  await expect(page).toHaveTitle(receiptName)
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")))
  await expect(page).toHaveTitle(original)
})
