import type { Page } from "@playwright/test"
import { expect, test } from "./support/test"

// The names of the CSS animations running on the page now.
const animations = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("*")]
      .map((element) => getComputedStyle(element).animationName)
      .filter((name) => name !== "none"),
  )

// The suite runs with reduced motion, as a person who asked for it would.
test("the landing grid does not pulse when motion is reduced", async ({
  page,
}) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()

  expect(await animations(page)).not.toContain("cell")
})

test.describe("with motion allowed", () => {
  test.use({ reducedMotion: "no-preference" })

  test("the landing grid pulses", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()

    expect(await animations(page)).toContain("cell")
  })
})
