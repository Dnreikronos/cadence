import { clearMock, countFetches, setMock, signInAs } from "./support/demo"
import { expect, test } from "./support/test"

// The signed-in shell polls GET /health and says so when the service is down or cannot
// reach Solana; while it is fine, it says nothing.
const down = "Can't reach Cadence"
const degraded = "Cadence can't reach Solana"

test("the shell says when the service is down or degraded, and clears once it is back", async ({
  page,
  watch,
}) => {
  // The health check, and the sidebar balance when it is down too.
  watch.allowStatus(503, /mock\.cadence\.test\//)
  // A fake clock to spend the minute between two checks.
  await page.clock.install()
  const checks = await countFetches(page, "/health")
  await signInAs(page, "admin")
  await expect.poll(checks).toBeGreaterThanOrEqual(1)
  const main = page.getByRole("main")
  await expect(main.getByText(down)).toHaveCount(0)
  await expect(main.getByText(degraded)).toHaveCount(0)

  // The RPC is unreachable: the next check finds the service degraded.
  await setMock(page, "rpc-down")
  await expect(async () => {
    await page.clock.fastForward(20_000)
    await expect(
      main.getByRole("status").filter({ hasText: degraded }),
    ).toBeVisible({ timeout: 500 })
  }).toPass()

  // The service stops answering: degraded turns into down.
  await setMock(page, "service-down")
  await expect(async () => {
    await page.clock.fastForward(5_000)
    await expect(
      main.getByRole("status").filter({ hasText: down }),
    ).toBeVisible({ timeout: 500 })
  }).toPass()

  // Back up: the notice goes on a later check, with no reload.
  await clearMock(page)
  await expect(async () => {
    await page.clock.fastForward(5_000)
    await expect(main.getByText(down)).toHaveCount(0, { timeout: 500 })
  }).toPass()
  await expect(main.getByText(degraded)).toHaveCount(0)
})
