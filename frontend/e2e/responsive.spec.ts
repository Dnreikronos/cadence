import { expectNoHorizontalOverflow, signInAs } from "./support/demo"
import { openScreen, screens } from "./support/screens"
import { expect, test } from "./support/test"

// A phone: 390 x 844.
test.use({ viewport: { width: 390, height: 844 } })

for (const screen of screens) {
  test.describe(screen.name, () => {
    test("has no horizontal overflow at 390 px", async ({ page }) => {
      await openScreen(page, screen)

      await expectNoHorizontalOverflow(page)
    })

    test("keeps its primary action reachable", async ({ page }) => {
      test.skip(screen.primary === null, "the screen has no primary action")
      await openScreen(page, screen)

      const action = screen.primary!(page).first()
      await action.scrollIntoViewIfNeeded()
      await expect(action).toBeVisible()
      await expect(action).toBeInViewport()
      // A trial click runs every actionability check, including "nothing covers it",
      // without pressing the button.
      await action.click({ trial: true })
    })
  })
}

test("the navigation drawer opens, reaches another screen and closes", async ({
  page,
}) => {
  await signInAs(page, "admin")

  await page.getByRole("button", { name: "Open menu" }).click()
  const drawer = page.getByRole("dialog")
  await expect(drawer.getByRole("navigation", { name: "Main" })).toBeVisible()
  await drawer.getByRole("link", { name: "People", exact: true }).click()

  await expect(page).toHaveURL("/company/people")
  await expect(drawer).toBeHidden()
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test("a dialog fits the phone", async ({ page }) => {
  await signInAs(page, "admin")
  await page.goto("/company/people")
  await page.getByRole("button", { name: "Add person" }).first().click()

  const dialog = page.getByRole("dialog", { name: "Add a person" })
  await expect(dialog).toBeVisible()
  const box = await dialog.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await expect(
    dialog.getByRole("button", { name: "Add person" }),
  ).toBeInViewport()
  await expectNoHorizontalOverflow(page)
})
