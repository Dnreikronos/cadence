import {
  clearMock,
  countFetches,
  navLink,
  setMock,
  sidebar,
  signInAs,
  type Scenario,
} from "./support/demo"
import { expect, test } from "./support/test"
import type { Page } from "@playwright/test"

// Bruno holds $8,000.00 private and was paid $4,200.00 and $3,800.00. A withdrawal is
// public: one that equals a payment he received can be linked to it, so it needs his
// agreement first.
async function openWithdraw(page: Page, ...scenarios: Scenario[]) {
  await signInAs(page, "recipient")
  // A scenario is set once the page has loaded, then the page is only navigated on the
  // client: a full load would reset the mock.
  await setMock(page, ...scenarios)
  await navLink(page, "Withdraw").click()
  await expect(page).toHaveURL("/me/withdraw")
  const card = page.getByRole("region", { name: "Withdraw to your wallet" })
  await expect(card).toContainText("$8,000.00")
  return card
}

// The real sign-out, from the account menu: it clears the query cache and the session.
async function signOut(page: Page, email: string) {
  await page.getByRole("button", { name: new RegExp(email) }).click()
  await page.getByRole("button", { name: "Sign out", exact: true }).click()
  await page.waitForURL("**/sign-in")
}

// The keys of the withdrawals this tab has saved, one list per person.
const savedKeys = (page: Page) =>
  page.evaluate(() =>
    Object.keys(window.sessionStorage).filter((key) =>
      key.startsWith("cadence:submissions:withdraw:"),
    ),
  )

const amountField = (card: ReturnType<Page["locator"]>) =>
  card.getByLabel("Amount to withdraw (USDC)")

test("an amount that matches a payment needs the acknowledgement", async ({
  page,
  watch,
}) => {
  watch.allowStatus(409, /\/unwrap$/)
  const card = await openWithdraw(page, "instant")

  await amountField(card).fill("4200")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()

  const warning = card.getByRole("group", {
    name: "This amount can be linked to a payment you received",
  })
  await expect(warning).toBeVisible()
  const agree = warning.getByRole("checkbox", {
    name: /I understand this withdrawal can be linked/,
  })
  await expect(agree).toBeFocused()
  await expect(agree).not.toBeChecked()

  // Without the box ticked, nothing is sent. The button is aria-disabled, not disabled, so
  // a click still reaches it and explains why: Playwright must be told to click anyway.
  await expect(
    warning.getByRole("button", { name: "Withdraw anyway" }),
  ).toHaveAttribute("aria-disabled", "true")
  await warning
    .getByRole("button", { name: "Withdraw anyway" })
    .click({ force: true })
  await expect(
    card.getByText("Tick the box to confirm you understand."),
  ).toBeVisible()
  await expect(sidebar(page)).toContainText("$8,000.00")

  await agree.check()
  await warning.getByRole("button", { name: "Withdraw anyway" }).click()

  const done = page.getByRole("region", { name: "Withdrawal complete" })
  await expect(done).toBeVisible()
  await expect(done).toContainText("$4,200.00")
  await expect(done).toContainText("Exact match")
  await expect(done).toContainText("Signature")
  await expect(sidebar(page)).toContainText("$3,800.00")
})

test("an amount that matches nothing goes straight through", async ({
  page,
}) => {
  const card = await openWithdraw(page, "instant")

  await amountField(card).fill("1234.56")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()

  await expect(card.getByRole("group")).toHaveCount(0)
  const done = page.getByRole("region", { name: "Withdrawal complete" })
  await expect(done).toBeVisible()
  await expect(done).toContainText("$1,234.56")
  await expect(done).toContainText("No match")
  await expect(sidebar(page)).toContainText("$6,765.44")
})

test("an amount close to a payment is a warning too", async ({
  page,
  watch,
}) => {
  watch.allowStatus(409, /\/unwrap$/)
  const card = await openWithdraw(page, "instant")

  // Within 1% of $3,800.00 but not equal.
  await amountField(card).fill("3810")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()

  await expect(
    card.getByRole("group", {
      name: "This amount can be linked to a payment you received",
    }),
  ).toBeVisible()
})

test("more than the balance, and an amount that is not a number, are refused", async ({
  page,
}) => {
  const card = await openWithdraw(page, "instant")

  const refusal = card.getByRole("alert")

  await amountField(card).fill("8000.01")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  await expect(refusal).toHaveText("That is more than your available balance")

  // A different refusal replaces the first: the second really was refused too.
  await amountField(card).fill("abc")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  await expect(refusal).toHaveText("Enter an amount")

  await amountField(card).fill("0")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  await expect(refusal).toHaveText("The amount must be more than zero")
  await expect(sidebar(page)).toContainText("$8,000.00")
})

test("a transaction the network rejects says nothing was sent, and the amount can be sent again", async ({
  page,
  watch,
}) => {
  watch.allowStatus(409, /\/unwrap\/confirm$/)
  const card = await openWithdraw(page, "instant")
  await setMock(page, "instant", "tx-failed")

  await amountField(card).fill("1234.56")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()

  await expect(card.getByText("The withdrawal didn't go through")).toBeVisible()
  await expect(card.getByText("may have gone through")).toHaveCount(0)
  await expect(sidebar(page)).toContainText("$8,000.00")

  // Nothing is held: the same amount goes out once the network accepts it.
  await clearMock(page)
  await setMock(page, "instant")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Withdrawal complete" }),
  ).toContainText("$1,234.56")
  await expect(sidebar(page)).toContainText("$6,765.44")
})

test("after the network does not confirm in time, the same amount is refused", async ({
  page,
  watch,
}) => {
  watch.allowStatus(409, /\/unwrap\/confirm$/)
  // The balance behind the sidebar is asked again too, and is down as well.
  watch.allowStatus(503, /mock\.cadence\.test\//)
  // The confirm gives up after 60 s of asking. A fake clock lets the test spend them: it is
  // installed before anything loads, and paused once the form is up, so from then on time
  // moves only when the test moves it.
  await page.clock.install()
  const confirms = await countFetches(page, "/unwrap/confirm")
  const card = await openWithdraw(page)
  const clockNow = () => page.evaluate(() => Date.now())
  await page.clock.pauseAt((await clockNow()) + 1_000)
  const start = await clockNow()

  await amountField(card).fill("1234.56")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  await expect.poll(confirms).toBe(1)
  // From here the service stops answering the confirm, so it is asked again and again.
  await setMock(page, "service-down")

  const held = card.getByText("The withdrawal may have gone through")
  // Half a minute of asking, and still asking: the service being down once, or twice, is
  // not the end of it. (Each step lets the next request go out before time moves again.)
  await expect(async () => {
    await page.clock.fastForward(5_000)
    expect(await confirms()).toBeGreaterThanOrEqual(3)
  }).toPass()
  expect((await clockNow()) - start).toBeLessThan(60_000)
  await expect(held).toBeHidden()
  await expect(card.getByText("Waiting for the network")).toBeVisible()

  // Past the minute it gives up, and says the money may have moved.
  await expect(async () => {
    await page.clock.fastForward(10_000)
    await expect(held).toBeVisible({ timeout: 500 })
  }).toPass()
  expect((await clockNow()) - start).toBeGreaterThanOrEqual(60_000)
  await expect(card.getByRole("alert")).toContainText("may have gone through")

  // The same amount is not sent again, even though the field still holds it.
  await page.clock.resume()
  await clearMock(page)
  await setMock(page, "instant")
  const withdraw = card.getByRole("button", { name: "Withdraw", exact: true })
  await expect(withdraw).toHaveAttribute("aria-disabled", "true")
  await withdraw.click({ force: true })
  await expect(
    card.getByText(
      "A withdrawal for this amount may already have gone through. Check your balance and history, or change the amount.",
    ),
  ).toBeVisible()
  await expect(sidebar(page)).toContainText("$8,000.00")

  // Another amount is its own withdrawal.
  await amountField(card).fill("500.25")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  const done = page.getByRole("region", { name: "Withdrawal complete" })
  await expect(done).toContainText("$500.25")
  await expect(sidebar(page)).toContainText("$7,499.75")
})

test("a reload while the network is confirming keeps the amount held, and another amount still goes out", async ({
  page,
  watch,
}) => {
  // Slow answers, a reload and a lookup held on purpose: well past the default 30 s on a slow runner.
  test.setTimeout(60_000)
  // After the reload the mock is empty again, so asking about the saved withdrawal gets a
  // 404: that says nothing about whether it landed, so the amount stays held.
  watch.allowStatus(404, /\/unwrap\/confirm$/)
  watch.allowStatus(409, /\/unwrap\/confirm$/)
  // The reload happens with the withdrawal in flight, so the browser asks first.
  const prompts: string[] = []
  page.on("dialog", (dialog) => {
    prompts.push(dialog.type())
    void dialog.accept()
  })

  // The lookup after the reload is held for 3 s, longer than the balance behind the form
  // takes (`slow` below), so the form is seen while it is still waiting for the answer.
  await page.addInitScript(() => {
    const original = window.fetch
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith("/unwrap/confirm")) {
        await new Promise((resolve) => setTimeout(resolve, 3_000))
      }
      return original(input, init)
    }
  })

  await signInAs(page, "recipient")
  // `slow` makes every answer take 1.5 s, so there is a window to reload in. It is read
  // from the URL on every load.
  await page.goto("/me/withdraw?mock=slow")
  const card = page.getByRole("region", { name: "Withdraw to your wallet" })
  await expect(card).toContainText("$8,000.00")

  await amountField(card).fill("1234.56")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  // It is saved as it is handed to the network (the steps are all listed from the start, so
  // their text does not say where it is).
  await expect.poll(() => savedKeys(page)).toHaveLength(1)
  await page.reload()
  expect(prompts).toContain("beforeunload")

  // The saved withdrawal is looked up before anything new can be sent.
  await expect(page.getByText("Checking your last withdrawal.")).toBeVisible()
  await expect(card).toContainText("$8,000.00")
  await expect(amountField(card)).toBeDisabled()
  await expect(page.getByText("Checking your last withdrawal.")).toBeHidden()

  // It could not be settled, so the same amount is refused, with the field still holding it.
  await expect(
    card.getByText("The withdrawal may have gone through"),
  ).toBeVisible()
  await setMock(page, "instant")
  await amountField(card).fill("1234.56")
  const withdraw = card.getByRole("button", { name: "Withdraw", exact: true })
  await expect(withdraw).toHaveAttribute("aria-disabled", "true")
  await withdraw.click({ force: true })
  await expect(
    card.getByText(
      "A withdrawal for this amount may already have gone through. Check your balance and history, or change the amount.",
    ),
  ).toBeVisible()
  await expect(sidebar(page)).toContainText("$8,000.00")

  // Another amount is its own withdrawal.
  await amountField(card).fill("500.25")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Withdrawal complete" }),
  ).toContainText("$500.25")
  await expect(sidebar(page)).toContainText("$7,499.75")
})

test("signing out keeps what a person left held, for them and for no one else", async ({
  page,
  watch,
}) => {
  test.setTimeout(60_000)
  watch.allowStatus(404, /\/unwrap\/confirm$/)
  watch.allowStatus(409, /\/unwrap\/confirm$/)
  page.on("dialog", (dialog) => void dialog.accept())
  const stored = () => savedKeys(page)

  await signInAs(page, "recipient")
  await page.goto("/me/withdraw?mock=slow")
  const card = page.getByRole("region", { name: "Withdraw to your wallet" })
  await expect(card).toContainText("$8,000.00")
  await amountField(card).fill("1234.56")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  await expect.poll(stored).toHaveLength(1)
  await page.reload()
  await expect(
    card.getByText("The withdrawal may have gone through"),
  ).toBeVisible()
  const [key] = await stored()
  expect(key).toBeDefined()
  // The key names a viewer by a hash, not by an email.
  expect(key).toMatch(/^cadence:submissions:withdraw:[0-9a-f]{16}$/)

  // Another person signs in on the same tab: nothing of the first one's is shown, or removed.
  await signOut(page, "bruno@solaris.test")
  await signInAs(page, "admin")
  // Let the home page finish asking before it is left: a request cut off by the navigation
  // is logged by the browser as a failure.
  await page.waitForLoadState("networkidle")
  await page.goto("/company/runs/new")
  await expect(
    page.getByRole("checkbox", { name: /Bruno Costa/ }),
  ).toBeVisible()
  await expect(page.getByText("may have gone through")).toHaveCount(0)
  expect(await stored()).toEqual([key])

  // The first one signs back in and still finds the amount held.
  await page.waitForLoadState("networkidle")
  await signOut(page, "ana@solaris.test")
  await signInAs(page, "recipient")
  await page.waitForLoadState("networkidle")
  await page.goto("/me/withdraw")
  await expect(card).toContainText("$8,000.00")
  await expect(
    card.getByText("The withdrawal may have gone through"),
  ).toBeVisible()
})
