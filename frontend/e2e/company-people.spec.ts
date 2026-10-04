import { navLink, signInAs } from "./support/demo"
import { expect, test } from "./support/test"
import type { Page } from "@playwright/test"

// The seed (src/lib/people/mock-repository.ts and src/lib/api/mocks/db.ts): four people,
// 4,200 + 3,800 + 6,300 + 9,500 = $23,800 a month. Mariana's invite has lapsed.
const seedTotal = "$23,800.00"

const row = (page: Page, name: string) =>
  page.getByRole("main").getByRole("listitem").filter({ hasText: name })

const summary = (page: Page) => page.getByText("per month")

async function addPerson(
  page: Page,
  person: { name: string; email: string; amount: string },
) {
  await page.getByRole("button", { name: "Add person" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Add a person" })
  await dialog.getByLabel("Name").fill(person.name)
  await dialog.getByLabel("Email").fill(person.email)
  await dialog.getByLabel("Monthly amount (USD)").fill(person.amount)
  await dialog.getByRole("button", { name: "Add person" }).click()
  return dialog
}

test.beforeEach(async ({ page }) => {
  await signInAs(page, "admin")
  await navLink(page, "People").click()
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible()
  await expect(summary(page)).toContainText(seedTotal)
})

test("lists the seeded people with their status", async ({ page }) => {
  await expect(summary(page)).toContainText("4 people")
  await expect(row(page, "Bruno Costa")).toContainText("Active")
  await expect(row(page, "Mariana Souza")).toContainText("Invite expired")
  await expect(row(page, "Bruno Costa")).toContainText("$4,200.00")
})

test("adds a person, and their amount joins the total", async ({ page }) => {
  const dialog = await addPerson(page, {
    name: "Ines Prado",
    email: "ines@solaris.test",
    amount: "1500",
  })

  await expect(dialog).toBeHidden()
  await expect(page.getByText("Ines Prado added")).toBeVisible()
  await expect(row(page, "Ines Prado")).toContainText("ines@solaris.test")
  await expect(row(page, "Ines Prado")).toContainText("$1,500.00")
  await expect(row(page, "Ines Prado")).toContainText("Not invited")
  await expect(summary(page)).toContainText("5 people")
  await expect(summary(page)).toContainText("$25,300.00")
})

test("refuses a duplicate email and keeps the dialog open", async ({
  page,
}) => {
  const dialog = await addPerson(page, {
    name: "Another Bruno",
    email: "bruno@solaris.test",
    amount: "100",
  })

  await expect(
    dialog.getByText(/Someone with this email is already on your list/),
  ).toBeVisible()
  await expect(dialog.getByLabel("Email")).toHaveAttribute(
    "aria-invalid",
    "true",
  )
  await expect(dialog).toBeVisible()

  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
  await expect(summary(page)).toContainText("4 people")
})

test("validates the form before saving", async ({ page }) => {
  await page.getByRole("button", { name: "Add person" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Add a person" })

  await dialog.getByRole("button", { name: "Add person" }).click()

  await expect(dialog.getByRole("alert").first()).toBeVisible()
  await expect(dialog).toBeVisible()
  await expect(summary(page)).toContainText("4 people")
})

test("edits a person's amount, and the total follows", async ({ page }) => {
  await page.getByRole("button", { name: "Edit Bruno Costa" }).click()
  const dialog = page.getByRole("dialog", { name: "Edit Bruno Costa" })
  await expect(dialog.getByLabel("Monthly amount (USD)")).toHaveValue("4200")

  await dialog.getByLabel("Monthly amount (USD)").fill("4500")
  await dialog.getByRole("button", { name: "Save changes" }).click()

  await expect(dialog).toBeHidden()
  await expect(page.getByText("Changes saved")).toBeVisible()
  await expect(row(page, "Bruno Costa")).toContainText("$4,500.00")
  await expect(summary(page)).toContainText("$24,100.00")
})

test("removes a person after confirming", async ({ page }) => {
  await page.getByRole("button", { name: "Remove Diego Martins" }).click()
  const dialog = page.getByRole("dialog", { name: "Remove Diego Martins?" })

  await dialog.getByRole("button", { name: "Remove", exact: true }).click()

  await expect(dialog).toBeHidden()
  await expect(page.getByText("Diego Martins removed")).toBeVisible()
  await expect(row(page, "Diego Martins")).toHaveCount(0)
  await expect(summary(page)).toContainText("3 people")
  await expect(summary(page)).toContainText("$17,500.00")
})

test("keeping a person leaves the list as it was", async ({ page }) => {
  await page.getByRole("button", { name: "Remove Diego Martins" }).click()
  const dialog = page.getByRole("dialog", { name: "Remove Diego Martins?" })

  await dialog.getByRole("button", { name: "Keep" }).click()

  await expect(dialog).toBeHidden()
  await expect(row(page, "Diego Martins")).toHaveCount(1)
})

test("invites again after an invite lapsed, then resends it", async ({
  page,
}) => {
  const mariana = row(page, "Mariana Souza")

  await mariana
    .getByRole("button", { name: "Invite again, Mariana Souza" })
    .click()

  await expect(
    page.getByText("Invite sent to mariana@solaris.test"),
  ).toBeVisible()
  await expect(mariana).toContainText("Invite sent")

  // A pending invite is "Resend": it issues a fresh link.
  await mariana.getByRole("button", { name: "Resend, Mariana Souza" }).click()
  await expect(
    page.getByText("Invite sent to mariana@solaris.test"),
  ).toHaveCount(2)
})

test("sends a new person's first invite", async ({ page }) => {
  await addPerson(page, {
    name: "Ines Prado",
    email: "ines@solaris.test",
    amount: "1500",
  })
  const ines = row(page, "Ines Prado")

  await ines.getByRole("button", { name: "Send invite, Ines Prado" }).click()

  await expect(page.getByText("Invite sent to ines@solaris.test")).toBeVisible()
  await expect(ines).toContainText("Invite sent")
  await expect(
    ines.getByRole("button", { name: "Resend, Ines Prado" }),
  ).toBeVisible()
})
