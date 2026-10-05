import { navLink, setMock, sidebar, signInAs } from "./support/demo"
import { expect, test } from "./support/test"
import type { Locator, Page } from "@playwright/test"

// The mock company holds $84,000.00 private. Payable people (activated, with an amount):
// Bruno $4,200, Diego $6,300, Northwind $9,500. Mariana has not accepted her invite, so
// a run leaves her out.
const amounts: Record<string, number> = {
  "Bruno Costa": 4200,
  "Diego Martins": 6300,
  "Northwind Audit": 9500,
}
const startBalance = 84_000

const usd = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD" })

const dollars = (text: string) => Number(text.replace(/[$,]/g, ""))

async function openNewRun(
  page: Page,
  ...scenarios: Parameters<typeof setMock>[1][]
) {
  await signInAs(page, "admin")
  // The mock lives in the page: set scenarios, then navigate on the client.
  await setMock(page, "instant", ...scenarios)
  await page.getByRole("link", { name: "New payroll run" }).first().click()
  await expect(page).toHaveURL("/company/runs/new")
  await expect(
    page.getByRole("checkbox", { name: /Bruno Costa/ }),
  ).toBeVisible()
}

const person = (page: Page, name: string) =>
  page.getByRole("checkbox", { name: new RegExp(name) })

const payButton = (page: Page) =>
  page.getByRole("button", {
    name: /^(Pay \d+ (people|person)|Pick who to pay)/,
  })

const rowOf = (page: Page, name: string) =>
  page
    .getByRole("region", { name: "Payments in this run" })
    .getByRole("listitem")
    .filter({ hasText: name })

async function listedAmounts(list: Locator) {
  const texts = await list.getByRole("listitem").allInnerTexts()
  return texts.map((text) =>
    dollars(/\$[\d,]+\.\d{2}/.exec(text)?.[0] ?? "$NaN"),
  )
}

test("everyone payable starts selected, and the left-out are explained", async ({
  page,
}) => {
  await openNewRun(page)

  for (const name of Object.keys(amounts)) {
    await expect(person(page, name)).toBeChecked()
  }
  await expect(page.getByText("Left out of this run (1)")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Resend the invite to Mariana Souza" }),
  ).toBeVisible()
  await expect(payButton(page)).toHaveText("Pay 3 people · $20,000.00")

  await person(page, "Northwind Audit").uncheck()
  await expect(payButton(page)).toHaveText("Pay 2 people · $10,500.00")

  // With some unticked, "Everyone" is a partial state: one click ticks all, the next none.
  const everyone = page.getByRole("checkbox", { name: /Everyone/ })
  await everyone.check()
  await expect(payButton(page)).toHaveText("Pay 3 people · $20,000.00")
  await everyone.uncheck()
  await expect(payButton(page)).toHaveText("Pick who to pay")
  await expect(payButton(page)).toBeDisabled()
})

test("the confirmation total equals the sum, and the run completes", async ({
  page,
}) => {
  await openNewRun(page)
  await expect(sidebar(page)).toContainText(usd(startBalance))
  await person(page, "Northwind Audit").uncheck()

  await payButton(page).click()
  const dialog = page.getByRole("dialog", { name: "Pay 2 people · $10,500.00" })
  await expect(dialog).toBeVisible()
  const listed = await listedAmounts(dialog)
  expect(listed).toHaveLength(2)
  expect(listed.reduce((sum, value) => sum + value, 0)).toBe(10_500)

  await dialog.getByRole("button", { name: "Confirm and sign" }).click()

  await expect(
    page.getByRole("heading", { name: "Payments to 2 people" }),
  ).toBeVisible()
  const progress = page.getByRole("region", { name: "Payments in this run" })
  await expect(progress.getByRole("status")).toContainText("2 of 2 confirmed")
  await expect(rowOf(page, "Bruno Costa")).toContainText("Confirmed")
  await expect(rowOf(page, "Diego Martins")).toContainText("Confirmed")
  await expect(progress).toContainText("Every payment is confirmed.")
  await expect(sidebar(page)).toContainText(usd(startBalance - 10_500))

  // The finished run is reachable, and Bruno's payment is in the list of payments.
  await page.getByRole("link", { name: "Open this run" }).click()
  await expect(page).toHaveURL(/\/company\/runs\/[0-9a-f-]{36}$/)
  await expect(
    page
      .getByRole("region", { name: "Payments in this run" })
      .getByRole("status"),
  ).toContainText("2 of 2 confirmed")
  await navLink(page, "Payments").click()
  await expect(
    page.getByRole("link", { name: "Payroll run" }).first(),
  ).toBeVisible()
})

test("a partial failure shows one failed and one expired, and the failed one can be retried", async ({
  page,
  watch,
}) => {
  watch.allowStatus(409, /\/runs\/[^/]+\/payments\/[^/]+\/confirm$/)
  await openNewRun(page, "partial-failure")
  await payButton(page).click()
  await page
    .getByRole("dialog", { name: "Pay 3 people · $20,000.00" })
    .getByRole("button", { name: "Confirm and sign" })
    .click()

  const progress = page.getByRole("region", { name: "Payments in this run" })
  await expect(progress.getByRole("status")).toContainText("1 of 3 confirmed")
  await expect(progress.getByRole("status")).toContainText("2 need attention")
  await expect(progress.getByText("Failed", { exact: true })).toHaveCount(1)
  await expect(progress.getByText("Expired", { exact: true })).toHaveCount(1)
  await expect(progress.getByText("Confirmed", { exact: true })).toHaveCount(1)

  const failed = progress
    .getByRole("listitem")
    .filter({ has: page.getByText("Failed", { exact: true }) })
  const confirmed = progress
    .getByRole("listitem")
    .filter({ has: page.getByText("Confirmed", { exact: true }) })
  const names = Object.keys(amounts)
  const failedText = await failed.innerText()
  const confirmedText = await confirmed.innerText()
  const failedPerson = names.find((name) => failedText.includes(name))
  const confirmedPerson = names.find((name) => confirmedText.includes(name))
  expect(failedPerson).toBeDefined()
  expect(confirmedPerson).toBeDefined()

  // Only the confirmed payment has left the balance.
  await expect(sidebar(page)).toContainText(
    usd(startBalance - amounts[confirmedPerson!]),
  )

  await progress
    .getByRole("button", { name: `Retry the payment to ${failedPerson}` })
    .click()

  await expect(progress.getByRole("status")).toContainText("2 of 3 confirmed")
  await expect(progress.getByText("Failed", { exact: true })).toHaveCount(0)
  await expect(progress.getByText("Expired", { exact: true })).toHaveCount(1)
  await expect(sidebar(page)).toContainText(
    usd(startBalance - amounts[confirmedPerson!] - amounts[failedPerson!]),
  )
})

test("people who were just paid are not ticked for the next run, and ticking them warns", async ({
  page,
}) => {
  await openNewRun(page)
  await person(page, "Northwind Audit").uncheck()
  await payButton(page).click()
  await page
    .getByRole("dialog", { name: "Pay 2 people · $10,500.00" })
    .getByRole("button", { name: "Confirm and sign" })
    .click()
  const progress = page.getByRole("region", { name: "Payments in this run" })
  await expect(progress.getByRole("status")).toContainText("2 of 2 confirmed")

  // Back to a new run by client-side navigation: the mock still has the payments.
  await page.getByRole("link", { name: "Back to payments" }).click()
  await page.getByRole("link", { name: "New payroll run" }).first().click()
  await expect(page).toHaveURL("/company/runs/new")

  for (const name of ["Bruno Costa", "Diego Martins"]) {
    await expect(person(page, name)).not.toBeChecked()
    await expect(person(page, name)).toHaveAccessibleDescription(
      "Paid in the last 24 hours, so not ticked. Tick to pay again.",
    )
  }
  await expect(page.getByText("Paid recently")).toHaveCount(2)
  await expect(person(page, "Northwind Audit")).toBeChecked()
  await expect(payButton(page)).toHaveText("Pay 1 person · $9,500.00")

  // Ticking one again is a choice, and a warned one, down to the confirmation.
  await person(page, "Bruno Costa").check()
  await expect(person(page, "Bruno Costa")).toHaveAccessibleDescription(
    "Paid in the last 24 hours. Ticked again, this pays them a second time.",
  )
  await payButton(page).click()
  const dialog = page.getByRole("dialog", { name: /^Pay 2 people/ })
  await expect(dialog.getByRole("alert")).toContainText(
    "Paid in the last 24 hours and ticked again: Bruno Costa. This pays them a second time.",
  )
  await expect(
    dialog.getByRole("button", { name: "Pay again and sign" }),
  ).toBeVisible()
})

test("a reload mid-run keeps who may have been paid out of the next run, and says so", async ({
  page,
  watch,
}) => {
  // After the reload the mock is empty, so asking about the saved payment gets a 404:
  // that is no answer about the payment, so the person stays out of the roster.
  watch.allowStatus(404, /\/runs\/[^/]+\/payments\/[^/]+\/confirm$/)
  watch.allowStatus(409, /\/runs\/[^/]+\/payments\/[^/]+\/confirm$/)
  const prompts: string[] = []
  page.on("dialog", (dialog) => {
    prompts.push(dialog.type())
    void dialog.accept()
  })

  await openNewRun(page)
  // Without `instant` the network takes a few seconds to confirm: time to reload in.
  await setMock(page)
  await person(page, "Diego Martins").uncheck()
  await person(page, "Northwind Audit").uncheck()
  await payButton(page).click()
  await page
    .getByRole("dialog", { name: "Pay 1 person · $4,200.00" })
    .getByRole("button", { name: "Confirm and sign" })
    .click()
  await expect(rowOf(page, "Bruno Costa")).toContainText("Waiting")
  await page.reload()
  expect(prompts).toContain("beforeunload")

  // Bruno's payment was sent, and cannot be told from here: he is not payable, and the
  // others still are.
  await expect(
    page.getByRole("heading", { name: "Last payment not settled (1)" }),
  ).toBeVisible()
  await expect(page.getByRole("checkbox", { name: /Bruno Costa/ })).toHaveCount(
    0,
  )
  await expect(person(page, "Diego Martins")).toBeVisible()
  await expect(payButton(page)).toHaveText("Pay 2 people · $15,800.00")
  const checking = page.getByRole("region", {
    name: "Last payment not settled (1)",
  })
  await expect(checking).toContainText("Bruno Costa")
  await expect(checking).toContainText("could pay them twice")
})

test("the same list asked for again after a reload goes out with the saved key", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept())
  const keys: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "POST" || !/\/runs$/.test(request.url())) return
    const key = request.postDataJSON()?.idempotency_key
    if (typeof key === "string") keys.push(key)
  })

  await signInAs(page, "admin")
  // `slow` holds the create for 1.5 s: the reload lands while its answer is not back.
  await page.goto("/company/runs/new?mock=slow")
  await expect(
    page.getByRole("checkbox", { name: /Bruno Costa/ }),
  ).toBeVisible()
  await payButton(page).click()
  await page
    .getByRole("dialog", { name: "Pay 3 people · $20,000.00" })
    .getByRole("button", { name: "Confirm and sign" })
    .click()
  await expect.poll(() => keys.length).toBe(1)
  await page.reload()

  await expect(
    page.getByRole("checkbox", { name: /Bruno Costa/ }),
  ).toBeVisible()
  await setMock(page, "instant")
  await payButton(page).click()
  await page
    .getByRole("dialog", { name: "Pay 3 people · $20,000.00" })
    .getByRole("button", { name: "Confirm and sign" })
    .click()
  await expect.poll(() => keys.length).toBe(2)
  expect(keys[1]).toBe(keys[0])
  await expect(
    page
      .getByRole("region", { name: "Payments in this run" })
      .getByRole("status"),
  ).toContainText("3 of 3 confirmed")
})
