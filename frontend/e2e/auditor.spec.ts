import { expectPaymentsCsv, readDownload } from "./support/csv"
import { navLink, signInAs } from "./support/demo"
import { expect, test } from "./support/test"
import type { Page } from "@playwright/test"

const rows = (page: Page) =>
  page
    .getByRole("table")
    .getByRole("row")
    .filter({ hasNot: page.getByRole("columnheader") })

const row = (page: Page, name: string) =>
  page.getByRole("row").filter({ hasText: name })

test.describe("/audit", () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, "auditor")
    await expect(page.getByRole("heading", { name: "Payments" })).toBeVisible()
  })

  test("says that every amount is readable, and lists the payments", async ({
    page,
  }) => {
    await expect(
      page.getByText(/You can see every amount of\s+Solaris\./),
    ).toBeVisible()
    await expect(
      page
        .getByRole("main")
        .getByRole("link", { name: "access log", exact: true }),
    ).toBeVisible()

    await expect(rows(page)).toHaveCount(4)
    await expect(row(page, "Northwind Audit")).toContainText("$9,500.00")
    await expect(row(page, "Diego Martins")).toContainText("$6,300.00")
    await expect(row(page, "Bruno Costa")).toHaveCount(2)
    await expect(page.getByText("All payments loaded")).toBeVisible()
    // An auditor has no wallet and no balance of their own.
    await expect(page.getByText("Private balance")).toHaveCount(0)
  })

  test("filters by name and by status", async ({ page }) => {
    await page.getByLabel("Paid to").fill("diego")
    await expect(rows(page)).toHaveCount(1)
    await expect(row(page, "Diego Martins")).toBeVisible()

    await page.getByLabel("Status").selectOption("pending")
    await expect(page.getByText("No payments match")).toBeVisible()

    await page.getByRole("button", { name: "Clear filters" }).click()
    await expect(rows(page)).toHaveCount(4)
  })

  test("opens the receipt of a payment", async ({ page }) => {
    await row(page, "Northwind Audit")
      .getByRole("button", { name: /Receipt/ })
      .click()

    const dialog = page.getByRole("dialog", { name: "Payment receipt" })
    await expect(dialog).toContainText("Paid by")
    await expect(dialog).toContainText("Solaris")
    await expect(dialog).toContainText("Northwind Audit")
    await expect(dialog).toContainText("$9,500.00")
    await dialog.getByRole("button", { name: "Close" }).first().click()
    await expect(dialog).toBeHidden()
  })

  test("exports every payment as a CSV with only the documented columns", async ({
    page,
  }) => {
    const download = page.waitForEvent("download")
    await page
      .getByRole("button", { name: "Export all payments (CSV)" })
      .click()

    const { filename, text } = await readDownload(await download)

    expect(filename).toMatch(/^cadence-audit-solaris-\d{4}-\d{2}-\d{2}\.csv$/)
    expectPaymentsCsv(text, 4)
    await expect(page.getByText("Export ready")).toBeVisible()
  })
})

test.describe("/audit/access-log", () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, "auditor")
    await navLink(page, "Access log").click()
    await expect(
      page.getByRole("heading", { name: "Access log" }),
    ).toBeVisible()
  })

  test("pages with Load more, and shows who read what but never an amount", async ({
    page,
  }) => {
    const table = page.getByRole("table", { name: "Access log" })
    await expect(rows(page)).toHaveCount(20)
    await expect(table.getByRole("row").nth(1)).toContainText("Payroll run")
    await expect(table).toContainText("Read payments")
    await expect(table).toContainText("Exported a CSV")

    await page.getByRole("button", { name: "Load more" }).click()

    await expect(rows(page)).toHaveCount(25)
    await expect(page.getByText("All entries loaded")).toBeVisible()
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0)

    // Names the data read, never an amount.
    await expect(page.getByRole("main")).not.toContainText(/\$\s?\d/)
    await expect(table).not.toContainText(/\d[\d,]*\.\d{2}/)
  })
})
