import { navLink, signInAs } from "./support/demo"
import { expect, test } from "./support/test"
import type { Page } from "@playwright/test"

// The seed: Ana is an active auditor, Paulo's invite is pending, Rita's has lapsed.
const ana = "ana.ribeiro@northwind-audit.example"
const paulo = "paulo.lima@northwind-audit.example"
const rita = "rita.alves@northwind-audit.example"

const row = (page: Page, email: string) =>
  page.getByRole("row").filter({ hasText: email })

async function invite(page: Page, email: string) {
  await page.getByRole("button", { name: "Invite auditor" }).click()
  const dialog = page.getByRole("dialog", { name: "Invite an auditor" })
  await dialog.getByLabel("Email").fill(email)
  await dialog.getByRole("button", { name: "Send invite" }).click()
  return dialog
}

test.beforeEach(async ({ page }) => {
  await signInAs(page, "admin")
  await navLink(page, "Auditors").click()
  await expect(page.getByRole("heading", { name: "Auditors" })).toBeVisible()
  await expect(page.getByText("3 auditors")).toBeVisible()
})

test("lists the auditors and the state of each invite", async ({ page }) => {
  await expect(row(page, ana)).toContainText("Active")
  await expect(row(page, paulo)).toContainText("Invite sent")
  await expect(row(page, rita)).toContainText("Invite expired")
  // An auditor reads everything: the page says so before anything else.
  await expect(page.getByText(/reads every payment amount/)).toBeVisible()
})

test("invites an auditor", async ({ page }) => {
  const dialog = await invite(page, "new.auditor@northwind-audit.example")

  await expect(dialog).toBeHidden()
  await expect(page.getByText("4 auditors")).toBeVisible()
  await expect(row(page, "new.auditor@northwind-audit.example")).toContainText(
    "Invite sent",
  )
})

test("validates the email before sending", async ({ page }) => {
  const dialog = await invite(page, "not-an-email")

  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(dialog.getByLabel("Email")).toHaveAttribute(
    "aria-invalid",
    "true",
  )
  await expect(page.getByText("3 auditors")).toBeVisible()
})

test("refuses to invite someone who is already an auditor", async ({
  page,
  watch,
}) => {
  watch.allowStatus(409, /\/company\/auditors$/)

  const dialog = await invite(page, ana)

  await expect(dialog.getByRole("alert")).toHaveText(
    "That person is already an auditor.",
  )
  await expect(dialog).toBeVisible()

  // The same goes for a pending invite.
  await dialog.getByLabel("Email").fill(paulo)
  await dialog.getByRole("button", { name: /Send invite|Try again/ }).click()
  await expect(dialog.getByRole("alert")).toHaveText(
    "That person already has an invite waiting.",
  )
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("3 auditors")).toBeVisible()
})

test("revokes an active auditor's access", async ({ page }) => {
  await page.getByRole("button", { name: `Revoke access for ${ana}` }).click()
  const dialog = page.getByRole("dialog", { name: `Revoke access for ${ana}?` })
  await expect(dialog).toContainText("Amounts they have already viewed")

  await dialog.getByRole("button", { name: "Revoke access" }).click()

  await expect(dialog).toBeHidden()
  await expect(row(page, ana)).toHaveCount(0)
  await expect(page.getByText("2 auditors")).toBeVisible()
})

test("invites again after an invite expired", async ({ page }) => {
  await row(page, rita)
    .getByRole("button", { name: `Invite again ${rita}` })
    .click()

  await expect(row(page, rita)).toContainText("Invite sent")
  await expect(row(page, rita)).not.toContainText("Invite expired")
  await expect(
    row(page, rita).getByRole("button", { name: /Invite again/ }),
  ).toHaveCount(0)
})

test("cancels a pending invite", async ({ page }) => {
  await page.getByRole("button", { name: `Cancel invite for ${paulo}` }).click()
  const dialog = page.getByRole("dialog", {
    name: `Cancel invite for ${paulo}?`,
  })

  await dialog.getByRole("button", { name: "Cancel invite" }).click()

  await expect(dialog).toBeHidden()
  await expect(row(page, paulo)).toHaveCount(0)
})
