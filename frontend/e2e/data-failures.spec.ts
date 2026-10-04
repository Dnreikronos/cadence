import { countFetches, navLink, setMock, signInAs } from "./support/demo"
import { expect, test } from "./support/test"

// How a data screen fails when the service says the session is over or the caller is
// rate-limited. Receipts stands for the company screens: they share the query layer.
const mockApi = /mock\.cadence\.test\//

test("an ended session says to sign in again, and offers no useless retry", async ({
  page,
  watch,
}) => {
  watch.allowStatus(401, mockApi)
  await signInAs(page, "admin")
  await setMock(page, "unauthenticated")

  await navLink(page, "Receipts").click()

  const error = page.getByRole("main").getByRole("alert")
  await expect(error).toContainText("Couldn't load your payments")
  await expect(error).toContainText(
    "Your session ended. Sign in again to continue.",
  )
  // Asking again cannot fix a session that ended.
  await expect(error.getByRole("button", { name: "Try again" })).toHaveCount(0)
})

test("a rate limit says to wait, and the screen does not ask again by itself", async ({
  page,
  watch,
}) => {
  watch.allowStatus(429, mockApi)
  // A fake clock to spend the time a retry loop would take.
  await page.clock.install()
  const requests = await countFetches(page, "/company/payments")
  await signInAs(page, "admin")
  await setMock(page, "rate-limited")
  const before = await requests()

  await navLink(page, "Receipts").click()

  const error = page.getByRole("main").getByRole("alert")
  await expect(error).toContainText("Wait a moment")
  await expect.poll(requests).toBe(before + 1)
  // Two minutes pass: still the one request.
  await page.clock.fastForward(120_000)
  await expect(error).toBeVisible()
  await expect.poll(requests).toBe(before + 1)

  // Asking again is the person's call, and goes out once they make it.
  await error.getByRole("button", { name: "Try again" }).click()
  await expect.poll(requests).toBe(before + 2)
  await expect(error).toContainText("Wait a moment")
})
