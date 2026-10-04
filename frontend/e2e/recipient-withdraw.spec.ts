import {
  clearMock,
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

const amountField = (card: ReturnType<Page["locator"]>) =>
  card.getByLabel("Amount to withdraw (USDC)")

test("an amount that matches a payment needs the acknowledgement", async ({
  page,
  watch,
}) => {
  watch.allowStatus(409)
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
  watch.allowStatus(409)
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

  await amountField(card).fill("8000.01")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  await expect(card.getByRole("alert")).toBeVisible()

  await amountField(card).fill("abc")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  await expect(card.getByRole("alert")).toBeVisible()
  await expect(sidebar(page)).toContainText("$8,000.00")
})

test("a transaction the network rejects says nothing was sent, and the amount can be sent again", async ({
  page,
  watch,
}) => {
  watch.allowStatus(409)
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
  watch.allowStatus(409, 503)
  // The confirm gives up after 60 s: a fake clock lets the test spend them at once. It
  // is installed before anything loads, and only moves when the test moves it.
  await page.clock.install()
  const card = await openWithdraw(page)

  await amountField(card).fill("1234.56")
  await card.getByRole("button", { name: "Withdraw", exact: true }).click()
  await expect(card.getByText("Waiting for the network")).toBeVisible()
  // From here the service stops answering the confirm, so it is asked again and again.
  await setMock(page, "service-down")

  const held = card.getByText("The withdrawal may have gone through")
  await expect(async () => {
    await page.clock.fastForward(15_000)
    await expect(held).toBeVisible({ timeout: 1_000 })
  }).toPass()
  await expect(card.getByRole("alert")).toContainText("may have gone through")

  // The same amount is not sent again, even though the field still holds it.
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
