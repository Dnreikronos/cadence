import { expectNoSeriousA11yViolations } from "./support/a11y"
import { signInAs, type Role } from "./support/demo"
import { openScreen, screens } from "./support/screens"
import { expect, test } from "./support/test"

const viewports = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const

for (const [viewport, size] of Object.entries(viewports) as [
  keyof typeof viewports,
  (typeof viewports)[keyof typeof viewports],
][]) {
  test.describe(`axe at ${viewport}`, () => {
    test.use({ viewport: size })

    for (const screen of screens) {
      test(`${screen.name} has no serious violations`, async ({ page }) => {
        await openScreen(page, screen)

        await expectNoSeriousA11yViolations(page, screen.name, viewport)
      })
    }

    test("the add-person dialog has no serious violations", async ({
      page,
    }) => {
      await signInAs(page, "admin")
      await page.goto("/company/people")
      await page.getByRole("button", { name: "Add person" }).first().click()
      await expect(
        page.getByRole("dialog", { name: "Add a person" }),
      ).toBeVisible()

      await expectNoSeriousA11yViolations(page, "add-person dialog", viewport)
    })

    test("the payroll confirmation has no serious violations", async ({
      page,
    }) => {
      await signInAs(page, "admin")
      await page.goto("/company/runs/new")
      await page.getByRole("button", { name: /^Pay 3 people/ }).click()
      await expect(
        page.getByRole("dialog", { name: /^Pay 3 people/ }),
      ).toBeVisible()

      await expectNoSeriousA11yViolations(
        page,
        "payroll confirmation",
        viewport,
      )
    })

    for (const role of ["admin", "recipient", "auditor"] as Role[]) {
      test(`the account menu of the ${role} has a name and no serious violations`, async ({
        page,
      }) => {
        await signInAs(page, role)
        // The button is the email on a wide screen, and just "Account" on a phone.
        await page
          .getByRole("banner")
          .getByRole("button", {
            name: /@solaris\.test|@acme-audit\.test|^Account$/,
          })
          .click()
        await expect(
          page.getByRole("dialog", { name: "Account menu" }),
        ).toBeVisible()

        await expectNoSeriousA11yViolations(
          page,
          `account menu (${role})`,
          viewport,
        )
      })
    }

    // The amount that is not there yet is a shape, not faded text: faded text fails the
    // contrast rule. Each screen is looked at while its balance is loading (held back) and
    // after it failed.
    for (const { name, role, path } of [
      { name: "company people", role: "admin", path: "/company/people" },
      { name: "company deposit", role: "admin", path: "/company/deposit" },
      { name: "recipient home", role: "recipient", path: "/me" },
    ] as const) {
      test(`${name} has no serious violations while its balance loads`, async ({
        page,
      }) => {
        // Held for longer than the check takes.
        await page.addInitScript(() => {
          const original = window.fetch
          window.fetch = async (input, init) => {
            const url = input instanceof Request ? input.url : String(input)
            if (new URL(url, location.href).pathname.endsWith("/balance")) {
              await new Promise((resolve) => setTimeout(resolve, 20_000))
            }
            return original(input, init)
          }
        })
        await signInAs(page, role)
        await page.goto(path)
        await expect(page.getByText("Decrypting amount").first()).toBeAttached()

        await expectNoSeriousA11yViolations(page, `${name} (loading)`, viewport)
      })

      test(`${name} has no serious violations when its balance fails`, async ({
        page,
        watch,
      }) => {
        watch.allowStatus(503, /mock\.cadence\.test\//)
        await signInAs(page, role)
        await page.goto(`${path}?mock=service-down`)
        await expect(
          page.getByRole("main").getByRole("alert").first(),
        ).toBeVisible()

        await expectNoSeriousA11yViolations(page, `${name} (error)`, viewport)
      })
    }

    test("a payment receipt has no serious violations", async ({ page }) => {
      await signInAs(page, "admin")
      await page.goto("/company/receipts")
      await page
        .getByRole("button", { name: "Receipt for Diego Martins, Sep 1, 2026" })
        .click()
      await expect(
        page.getByRole("dialog", { name: "Payment receipt" }),
      ).toBeVisible()

      await expectNoSeriousA11yViolations(page, "receipt dialog", viewport)
    })
  })
}

// The suite runs with reduced motion, so dialogs are in place at once. Once, with the
// transitions on, to be sure the check also holds for what a person with motion sees.
test.describe("axe with motion on", () => {
  test.use({ reducedMotion: "no-preference" })

  test("the add-person dialog has no serious violations", async ({ page }) => {
    await signInAs(page, "admin")
    await page.goto("/company/people")
    await page.getByRole("button", { name: "Add person" }).first().click()
    await expect(
      page.getByRole("dialog", { name: "Add a person" }),
    ).toBeVisible()

    await expectNoSeriousA11yViolations(
      page,
      "add-person dialog (motion)",
      "desktop",
    )
  })
})
