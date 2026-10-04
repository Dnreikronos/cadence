import { expectNoSeriousA11yViolations } from "./support/a11y"
import { signInAs } from "./support/demo"
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
