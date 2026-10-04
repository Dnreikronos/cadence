import { demoEmails, homes, signInAs, type Role } from "./support/demo"
import { expect, test } from "./support/test"

const roles: Role[] = ["admin", "recipient", "auditor"]
const roleBadge: Record<Role, string> = {
  admin: "Admin",
  recipient: "Recipient",
  auditor: "Auditor",
}

test.describe("demo sign-in", () => {
  for (const role of roles) {
    test(`the ${role} lands on their home`, async ({ page }) => {
      await signInAs(page, role)

      await expect(page).toHaveURL(homes[role])
      const header = page.getByRole("banner")
      await expect(header.getByText("Solaris", { exact: true })).toBeVisible()
      await expect(
        header.getByText(roleBadge[role], { exact: true }),
      ).toBeVisible()
      await expect(header.getByText(demoEmails[role])).toBeVisible()
    })
  }

  test("signing out returns to /sign-in and ends the session", async ({
    page,
  }) => {
    await signInAs(page, "admin")

    await page.getByRole("button", { name: /ana@solaris\.test/ }).click()
    await page.getByRole("button", { name: "Sign out", exact: true }).click()
    await page.waitForURL("**/sign-in")
    await expect(
      page.getByRole("heading", { name: "Try the demo" }),
    ).toBeVisible()

    // The cookie is gone: the guarded area asks for a session again.
    await page.goto("/company")
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fcompany$/)
  })
})

test.describe("route guard", () => {
  test("a guarded route without a session redirects with `next`, and signing in returns to it", async ({
    page,
  }) => {
    await page.goto("/company/people?from=e2e")
    await expect(page).toHaveURL(
      "/sign-in?next=%2Fcompany%2Fpeople%3Ffrom%3De2e",
    )

    await page.getByRole("button", { name: /^Company admin/ }).click()
    await expect(page).toHaveURL("/company/people?from=e2e")
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible()
  })

  test("a `next` that belongs to another role is dropped", async ({ page }) => {
    await page.goto("/audit")
    await expect(page).toHaveURL("/sign-in?next=%2Faudit")

    await page.getByRole("button", { name: /^Company admin/ }).click()
    await expect(page).toHaveURL("/company")
  })

  const visits: { role: Role; path: string }[] = [
    { role: "admin", path: "/me" },
    { role: "admin", path: "/audit/access-log" },
    { role: "recipient", path: "/company/deposit" },
    { role: "recipient", path: "/audit" },
    { role: "auditor", path: "/company" },
    { role: "auditor", path: "/me/withdraw" },
  ]
  for (const { role, path } of visits) {
    test(`the ${role} visiting ${path} is sent home`, async ({ page }) => {
      await signInAs(page, role)

      await page.goto(path)

      await expect(page).toHaveURL(homes[role])
    })
  }

  test("a signed-in visitor of /sign-in goes straight home", async ({
    page,
  }) => {
    await signInAs(page, "auditor")

    await page.goto("/sign-in")

    await expect(page).toHaveURL(homes.auditor)
  })
})
