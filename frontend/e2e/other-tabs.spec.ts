import type { BrowserContext, Locator, Page } from "@playwright/test"
import { setMock, signInAs } from "./support/demo"
import { expect, test } from "./support/test"

// What a second tab of the same browser sees of a transaction the first tab may have sent.
// The tabs share the session cookie, localStorage (where the records of what may have been
// sent live) and the Web Locks (held while one is sending or looking one up). Each tab has
// its own mock service, which lives in the page, so a test sets each tab's up on its own.

const otherTab = (what: string) =>
  `Another tab is sending or checking ${what === "update" ? "an" : "a"} ${what} for this account: wait for it to finish.`

// Whether the browser holds a lock of this flow (its names begin `cadence:flow:<kind>:`).
const lockHeld = (page: Page, kind: string) =>
  page.evaluate(
    async (kind) =>
      (await navigator.locks.query()).held?.some((lock) =>
        lock.name?.startsWith(`cadence:flow:${kind}:`),
      ) ?? false,
    kind,
  )

// The records this browser has saved under a prefix, parsed.
const saved = (page: Page, prefix: string) =>
  page.evaluate((prefix) => {
    const found: unknown[] = []
    for (const key of Object.keys(window.localStorage)) {
      if (!key.startsWith(prefix) || key.endsWith(":unreadable")) continue
      const value: unknown = JSON.parse(
        window.localStorage.getItem(key) ?? "null",
      )
      found.push(...(Array.isArray(value) ? value : [value]))
    }
    return found as Record<string, unknown>[]
  }, prefix)

// The POSTs a tab makes to the service whose path ends with `suffix` (the prepare, as the
// lookups of a saved signature go to `.../confirm`), with their JSON bodies.
function posts(page: Page, suffix: RegExp) {
  const bodies: Record<string, unknown>[] = []
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      suffix.test(new URL(request.url()).pathname)
    ) {
      bodies.push(request.postDataJSON() as Record<string, unknown>)
    }
  })
  return bodies
}

// ---- Withdraw -----------------------------------------------------------------

const amountField = (card: Locator) =>
  card.getByLabel("Amount to withdraw (USDC)")
const withdrawButton = (card: Locator) =>
  card.getByRole("button", { name: "Withdraw", exact: true })
const withdrawCard = (page: Page) =>
  page.getByRole("region", { name: "Withdraw to your wallet" })

test.describe("withdraw", () => {
  test("a second tab cannot send what the first holds as having maybe gone through, and another amount still goes", async ({
    page,
    context,
    watch,
  }) => {
    test.setTimeout(90_000)
    // After the reload the first tab's mock is empty: asking about the saved withdrawal gets
    // a 404, which says nothing about it, so the amount stays held.
    watch.allowStatus(404, /\/unwrap\/confirm$/)
    watch.allowStatus(409, /\/unwrap\/confirm$/)
    page.on("dialog", (dialog) => void dialog.accept())

    await signInAs(page, "recipient")
    await page.goto("/me/withdraw?mock=slow")
    const card = withdrawCard(page)
    await expect(card).toContainText("$8,000.00")
    await amountField(card).fill("1234.56")
    await withdrawButton(card).click()
    await expect
      .poll(() => saved(page, "cadence:submissions:withdraw:"))
      .toHaveLength(1)
    await page.reload()
    await expect(
      card.getByText("The withdrawal may have gone through"),
    ).toBeVisible()

    // The second tab is told the same before anything is typed: the amount is held there too.
    const other = await context.newPage()
    other.on("dialog", (dialog) => void dialog.accept())
    const sent = posts(other, /\/unwrap$/)
    await other.goto("/me/withdraw?mock=instant")
    const otherCard = withdrawCard(other)
    await expect(otherCard).toContainText("$8,000.00")
    await expect(
      otherCard.getByText("The withdrawal may have gone through"),
    ).toBeVisible()

    await amountField(otherCard).fill("1234.56")
    const withdraw = withdrawButton(otherCard)
    await expect(withdraw).toHaveAttribute("aria-disabled", "true")
    await withdraw.click({ force: true })
    await expect(
      otherCard.getByText(
        "A withdrawal for this amount may already have gone through. Check your balance and history, or change the amount.",
      ),
    ).toBeVisible()
    expect(sent).toEqual([])

    // Another amount is its own withdrawal, and goes out from the second tab.
    await amountField(otherCard).fill("500.25")
    await withdrawButton(otherCard).click()
    await expect(
      other.getByRole("region", { name: "Withdrawal complete" }),
    ).toContainText("$500.25")
    expect(sent.map((body) => body.amount)).toEqual(["500250000"])
    // The first tab's amount is still the one that is held, for both.
    expect(
      (await saved(other, "cadence:submissions:withdraw:")).map(
        (r) => r.amount_units,
      ),
    ).toEqual(["1234560000"])
  })

  test("a second tab opened while the first is sending waits for it, and is free when it is done", async ({
    page,
    context,
    watch,
  }) => {
    test.setTimeout(90_000)
    watch.allowStatus(409, /\/unwrap\/confirm$/)
    page.on("dialog", (dialog) => void dialog.accept())

    await signInAs(page, "recipient")
    await page.goto("/me/withdraw?mock=slow")
    const card = withdrawCard(page)
    await expect(card).toContainText("$8,000.00")
    await amountField(card).fill("1234.56")
    await withdrawButton(card).click()
    // Saved with its signature: what the second tab will look up.
    await expect
      .poll(async () =>
        (await saved(page, "cadence:submissions:withdraw:")).some(
          (r) => r.signature,
        ),
      )
      .toBe(true)

    const other = await context.newPage()
    other.on("dialog", (dialog) => void dialog.accept())
    const sent = posts(other, /\/unwrap$/)
    await other.goto("/me/withdraw?mock=instant")
    const otherCard = withdrawCard(other)
    await expect(otherCard.getByText(otherTab("withdrawal"))).toBeVisible()
    await expect(amountField(otherCard)).toBeDisabled()
    expect(sent).toEqual([])

    // The first one finishes and removes its record; the second is free, with nothing held.
    await expect(
      page.getByRole("region", { name: "Withdrawal complete" }),
    ).toBeVisible({
      timeout: 40_000,
    })
    await expect(amountField(otherCard)).toBeEnabled({ timeout: 20_000 })
    await expect(otherCard.getByText("may have gone through")).toHaveCount(0)
    await expect(otherCard.getByText(otherTab("withdrawal"))).toHaveCount(0)
    expect(sent).toEqual([])
  })
})

// ---- Payroll ------------------------------------------------------------------

const payButton = (page: Page, people: number) =>
  page.getByRole("button", {
    name: new RegExp(`^Pay ${people} (people|person)`),
  })
const personBox = (page: Page, name: string) =>
  page.getByRole("checkbox", { name: new RegExp(name) })

test.describe("payroll", () => {
  test("a person the first tab may have paid is not payable in the second, which pays the others", async ({
    page,
    context,
    watch,
  }) => {
    test.setTimeout(90_000)
    // The first tab's mock is empty after its reload: the saved payment's lookup gets a 404.
    watch.allowStatus(404, /\/runs\/[^/]+\/confirm$/)
    page.on("dialog", (dialog) => void dialog.accept())

    await signInAs(page, "admin")
    await page.goto("/company/runs/new")
    await expect(personBox(page, "Bruno Costa")).toBeVisible()
    // Without a scenario the network takes a few seconds to confirm: time to reload in.
    await setMock(page)
    await personBox(page, "Diego Martins").uncheck()
    await personBox(page, "Northwind Audit").uncheck()
    await payButton(page, 1).click()
    await page
      .getByRole("dialog", { name: "Pay 1 person · $4,200.00" })
      .getByRole("button", { name: "Confirm and sign" })
      .click()
    await expect
      .poll(() => saved(page, "cadence:submissions:payroll-sent:"))
      .toHaveLength(1)
    await page.reload()
    await expect(
      page.getByRole("heading", { name: "Last payment not settled (1)" }),
    ).toBeVisible()

    // The second tab, opened later, has the same answer: Bruno is not in its roster, and
    // what it sends does not pay him.
    const other = await context.newPage()
    other.on("dialog", (dialog) => void dialog.accept())
    const runs = posts(other, /\/runs$/)
    await other.goto("/company/runs/new?mock=instant")
    await expect(personBox(other, "Diego Martins")).toBeVisible()
    await expect(
      other.getByRole("heading", { name: "Last payment not settled (1)" }),
    ).toBeVisible()
    await expect(personBox(other, "Bruno Costa")).toHaveCount(0)
    await expect(payButton(other, 2)).toHaveText("Pay 2 people · $15,800.00")

    await payButton(other, 2).click()
    await other
      .getByRole("dialog", { name: "Pay 2 people · $15,800.00" })
      .getByRole("button", { name: "Confirm and sign" })
      .click()
    await expect(
      other
        .getByRole("region", { name: "Payments in this run" })
        .getByRole("status"),
    ).toContainText("2 of 2 confirmed")
    expect(runs).toHaveLength(1)
    expect((runs[0].payments as unknown[]).length).toBe(2)
  })

  test("a second tab cannot create a run while the first is sending one", async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000)
    page.on("dialog", (dialog) => void dialog.accept())

    await signInAs(page, "admin")
    // The second tab is opened first, with its confirmation already up: it has nothing saved
    // to show yet.
    const other = await context.newPage()
    other.on("dialog", (dialog) => void dialog.accept())
    const runs = posts(other, /\/runs$/)
    await other.goto("/company/runs/new?mock=instant")
    await expect(personBox(other, "Bruno Costa")).toBeVisible()
    await payButton(other, 3).click()
    const dialog = other.getByRole("dialog", {
      name: "Pay 3 people · $20,000.00",
    })
    await expect(dialog).toBeVisible()

    const first = posts(page, /\/runs$/)
    await page.goto("/company/runs/new?mock=slow")
    await expect(personBox(page, "Bruno Costa")).toBeVisible()
    await payButton(page, 3).click()
    await page
      .getByRole("dialog", { name: "Pay 3 people · $20,000.00" })
      .getByRole("button", { name: "Confirm and sign" })
      .click()
    // The run is asked for once the run lock is held.
    await expect.poll(() => first.length).toBe(1)

    await dialog.getByRole("button", { name: "Confirm and sign" }).click()
    await expect(dialog.getByRole("alert")).toContainText(otherTab("run"))
    expect(runs).toEqual([])
  })
})

// ---- Deposit ------------------------------------------------------------------

const depositField = (page: Page) =>
  page.getByLabel("Amount to make private (USDC)")
const makePrivate = (page: Page) =>
  page.getByRole("button", { name: "Make private" })

test.describe("deposit", () => {
  test("a second tab opened while the first is depositing waits for it, and sends nothing meanwhile", async ({
    page,
    context,
    watch,
  }) => {
    test.setTimeout(120_000)
    watch.allowStatus(409, /\/(wrap|accounts\/apply-pending)\/confirm$/)
    page.on("dialog", (dialog) => void dialog.accept())

    await signInAs(page, "admin")
    await page.goto("/company/deposit?mock=slow")
    await expect(page.getByText("$12,500.00").first()).toBeVisible()
    await depositField(page).fill("1000")
    await makePrivate(page).click()
    // The wrap is saved, with its signature, once it has been handed to the network.
    await expect
      .poll(async () =>
        (await saved(page, "cadence:submission:wrap:")).some(
          (r) => r.signature,
        ),
      )
      .toBe(true)

    const other = await context.newPage()
    other.on("dialog", (dialog) => void dialog.accept())
    const wraps = posts(other, /\/wrap$/)
    await other.goto("/company/deposit?mock=instant")
    await expect(other.getByText("$12,500.00").first()).toBeVisible()
    await expect(other.getByText("Checking your last deposit.")).toBeVisible()
    await expect(other.getByText(otherTab("deposit"))).toBeVisible()
    // Nothing can be started from it: the field is read-only and the button refuses.
    await expect(depositField(other)).toHaveAttribute("readonly", "")
    await expect(
      other.getByRole("button", { name: "Working…" }),
    ).toHaveAttribute("aria-disabled", "true")
    expect(wraps).toEqual([])

    // The first one finishes and clears its record: the second is free, and tells nothing.
    await expect(
      page.getByText(/1000 USDC is now in your private balance/),
    ).toBeVisible({
      timeout: 60_000,
    })
    await expect(depositField(other)).not.toHaveAttribute("readonly", "", {
      timeout: 20_000,
    })
    await expect(other.getByText(otherTab("deposit"))).toHaveCount(0)
    expect(wraps).toEqual([])
  })

  test("a second tab that was open before the first started is refused while it is in flight, and can go after", async ({
    page,
    context,
    watch,
  }) => {
    test.setTimeout(120_000)
    watch.allowStatus(409, /\/(wrap|accounts\/apply-pending)\/confirm$/)
    page.on("dialog", (dialog) => void dialog.accept())

    await signInAs(page, "admin")
    const other = await context.newPage()
    other.on("dialog", (dialog) => void dialog.accept())
    const wraps = posts(other, /\/wrap$/)
    await other.goto("/company/deposit?mock=instant")
    await expect(other.getByText("$12,500.00").first()).toBeVisible()

    await page.goto("/company/deposit?mock=slow")
    await expect(page.getByText("$12,500.00").first()).toBeVisible()
    await depositField(page).fill("1000")
    await makePrivate(page).click()
    await expect.poll(() => lockHeld(page, "deposit")).toBe(true)

    await depositField(other).fill("1000")
    await makePrivate(other).click()
    await expect(other.getByText(otherTab("deposit"))).toBeVisible()
    expect(wraps).toEqual([])

    // Once the first has finished the lock is free, and the second one's own try goes out.
    await expect(
      page.getByText(/1000 USDC is now in your private balance/),
    ).toBeVisible({
      timeout: 60_000,
    })
    await expect(depositField(other)).not.toHaveAttribute("readonly", "")
    // Refused at the click, it says so and offers to dismiss that; if the first tab's saved
    // wrap reached it first, it was already waiting on that tab and has nothing to dismiss.
    const dismiss = other.getByRole("button", { name: "Dismiss" })
    if (await dismiss.isVisible()) await dismiss.click()
    await depositField(other).fill("1000")
    await makePrivate(other).click()
    await expect(
      other.getByText(/1000 USDC is now in your private balance/),
    ).toBeVisible()
    expect(wraps).toHaveLength(1)
  })

  test("a deposit the first tab cannot account for is held in both, and a release in one frees both", async ({
    page,
    context,
    watch,
  }) => {
    test.setTimeout(120_000)
    // After the reload the mock is empty: the service has no record of the wrap, which says
    // nothing about whether it landed.
    watch.allowStatus(404, /\/wrap\/confirm$/)
    watch.allowStatus(409, /\/wrap\/confirm$/)
    page.on("dialog", (dialog) => void dialog.accept())

    await signInAs(page, "admin")
    await page.goto("/company/deposit?mock=slow")
    await expect(page.getByText("$12,500.00").first()).toBeVisible()
    await depositField(page).fill("1000")
    await makePrivate(page).click()
    await expect
      .poll(async () =>
        (await saved(page, "cadence:submission:wrap:")).some(
          (r) => r.signature,
        ),
      )
      .toBe(true)
    await page.reload()
    const held = page.getByText(
      "We couldn't tell whether your last deposit went through",
    )
    await expect(held).toBeVisible({ timeout: 30_000 })
    // The record stays: this is what the other tab reads.
    expect(await saved(page, "cadence:submission:wrap:")).toHaveLength(1)

    // The second tab finds it, cannot tell either, and holds the same way.
    const other = await context.newPage()
    other.on("dialog", (dialog) => void dialog.accept())
    const wraps = posts(other, /\/wrap$/)
    await other.goto("/company/deposit?mock=instant")
    await expect(other.getByText("$12,500.00").first()).toBeVisible()
    await expect(
      other.getByText(
        "We couldn't tell whether your last deposit went through",
      ),
    ).toBeVisible({ timeout: 30_000 })
    await expect(depositField(other)).toHaveAttribute("readonly", "")
    await expect(makePrivate(other)).toHaveAttribute("aria-disabled", "true")
    expect(wraps).toEqual([])
    // Not offered a release yet: it was sent a moment ago.
    await expect(
      other.getByRole("button", {
        name: "I checked my history, release this amount",
      }),
    ).toHaveCount(0)

    // Two minutes on, the first tab offers the release; releasing it frees both.
    await page.evaluate(() => {
      for (const key of Object.keys(window.localStorage)) {
        if (!key.startsWith("cadence:submission:wrap:")) continue
        const record = JSON.parse(window.localStorage.getItem(key) ?? "{}")
        record.at -= 3 * 60_000
        window.localStorage.setItem(key, JSON.stringify(record))
      }
    })
    await page.reload()
    await expect(held).toBeVisible({ timeout: 30_000 })
    await page
      .getByRole("button", {
        name: "I checked my history, release this amount",
      })
      .click()
    await page.getByRole("button", { name: "Release this amount" }).click()

    await expect(held).toHaveCount(0)
    expect(await saved(page, "cadence:submission:wrap:")).toEqual([])
    await expect(
      other.getByText(
        "We couldn't tell whether your last deposit went through",
      ),
    ).toHaveCount(0)
    await expect(depositField(other)).not.toHaveAttribute("readonly", "")

    // Nothing is held any more: the second tab sends its own deposit.
    await depositField(other).fill("1000")
    await makePrivate(other).click()
    await expect(
      other.getByText(/1000 USDC is now in your private balance/),
    ).toBeVisible()
    expect(wraps).toHaveLength(1)
  })

  test("signing out keeps a held deposit: the same person signing back in finds it held, and nothing is sent", async ({
    page,
    watch,
  }) => {
    test.setTimeout(120_000)
    watch.allowStatus(404, /\/wrap\/confirm$/)
    watch.allowStatus(409, /\/wrap\/confirm$/)
    page.on("dialog", (dialog) => void dialog.accept())
    const wraps = posts(page, /\/wrap$/)

    await signInAs(page, "admin")
    await page.goto("/company/deposit?mock=slow")
    await expect(page.getByText("$12,500.00").first()).toBeVisible()
    await depositField(page).fill("1000")
    await makePrivate(page).click()
    await expect
      .poll(async () =>
        (await saved(page, "cadence:submission:wrap:")).some(
          (r) => r.signature,
        ),
      )
      .toBe(true)
    await page.reload()
    const held = page.getByText(
      "We couldn't tell whether your last deposit went through",
    )
    await expect(held).toBeVisible({ timeout: 30_000 })
    expect(wraps).toHaveLength(1)

    await page.getByRole("button", { name: /ana@solaris\.test/ }).click()
    await page.getByRole("button", { name: "Sign out", exact: true }).click()
    await page.waitForURL("**/sign-in")
    expect(await saved(page, "cadence:submission:wrap:")).toHaveLength(1)

    await signInAs(page, "admin")
    await page.waitForLoadState("networkidle")
    await page.goto("/company/deposit")
    await expect(held).toBeVisible({ timeout: 30_000 })
    await expect(depositField(page)).toHaveAttribute("readonly", "")
    await expect(makePrivate(page)).toHaveAttribute("aria-disabled", "true")
    expect(wraps).toHaveLength(1)
  })

  test("a release made on a stale view cannot clear a deposit another tab sent since", async ({
    page,
    context,
    watch,
  }) => {
    test.setTimeout(150_000)
    watch.allowStatus(404, /\/wrap\/confirm$/)
    watch.allowStatus(409, /\/(wrap|accounts\/apply-pending)\/confirm$/)
    page.on("dialog", (dialog) => void dialog.accept())

    await signInAs(page, "admin")
    await page.goto("/company/deposit?mock=slow")
    await expect(page.getByText("$12,500.00").first()).toBeVisible()
    await depositField(page).fill("1000")
    await makePrivate(page).click()
    await expect
      .poll(async () =>
        (await saved(page, "cadence:submission:wrap:")).some(
          (r) => r.signature,
        ),
      )
      .toBe(true)
    // Two minutes on, so the release is offered.
    await page.evaluate(() => {
      for (const key of Object.keys(window.localStorage)) {
        if (!key.startsWith("cadence:submission:wrap:")) continue
        const record = JSON.parse(window.localStorage.getItem(key) ?? "{}")
        record.at -= 3 * 60_000
        window.localStorage.setItem(key, JSON.stringify(record))
      }
    })
    await page.reload()
    const held = page.getByText(
      "We couldn't tell whether your last deposit went through",
    )
    await expect(held).toBeVisible({ timeout: 30_000 })

    // The second tab sees the same hold, and never hears of what the first does next: its
    // `storage` events are swallowed.
    const other = await context.newPage()
    other.on("dialog", (dialog) => void dialog.accept())
    await other.addInitScript(() => {
      const original = window.addEventListener.bind(window)
      window.addEventListener = ((type: string, ...rest: unknown[]) => {
        if (type === "storage") return
        return (original as (...a: unknown[]) => void)(type, ...rest)
      }) as typeof window.addEventListener
    })
    const wraps = posts(other, /\/wrap$/)
    await other.goto("/company/deposit?mock=instant")
    await expect(
      other.getByText(
        "We couldn't tell whether your last deposit went through",
      ),
    ).toBeVisible({ timeout: 30_000 })
    const otherRelease = other.getByRole("button", {
      name: "I checked my history, release this amount",
    })
    await expect(otherRelease).toBeVisible()

    // The first tab releases, and sends again: a new wrap, in flight.
    await page
      .getByRole("button", {
        name: "I checked my history, release this amount",
      })
      .click()
    await page.getByRole("button", { name: "Release this amount" }).click()
    await expect(held).toHaveCount(0)
    await depositField(page).fill("1000")
    await makePrivate(page).click()
    await expect
      .poll(async () => {
        const [record] = await saved(page, "cadence:submission:wrap:")
        return Boolean(record && Date.now() - Number(record.at) < 60_000)
      })
      .toBe(true)
    const [inFlight] = await saved(page, "cadence:submission:wrap:")

    // The second tab, still showing the old hold, decides to release it.
    await otherRelease.click()
    await other.getByRole("button", { name: "Release this amount" }).click()
    await expect(other.getByRole("main").getByRole("alert")).toContainText(
      /Another tab is sending or checking a deposit|changed in another tab/,
    )

    // The first tab's wrap is untouched, and nothing was sent from the second.
    expect(await saved(page, "cadence:submission:wrap:")).toEqual([inFlight])
    expect(wraps).toEqual([])
    await expect(
      page.getByText(/1000 USDC is now in your private balance/),
    ).toBeVisible({ timeout: 60_000 })
    expect(await saved(page, "cadence:submission:wrap:")).toEqual([])
  })
})

// ---- Apply pending ------------------------------------------------------------

// Gives a tab's mock a pending credit for the recipient: the admin pays a run in that mock,
// then the session is switched to the recipient and the page goes there on the client, so
// the mock keeps its state (a full load would reset it).
async function seedPending(
  page: Page,
  context: BrowserContext,
  origin: string,
) {
  await context.addCookies([
    { name: "cadence-demo-role", value: "admin", url: origin },
  ])
  await page.goto("/company/runs/new")
  await expect(payButton(page, 3)).toBeVisible()
  await setMock(page, "instant")
  await payButton(page, 3).click()
  await page
    .getByRole("dialog", { name: "Pay 3 people · $20,000.00" })
    .getByRole("button", { name: "Confirm and sign" })
    .click()
  await expect(
    page
      .getByRole("region", { name: "Payments in this run" })
      .getByRole("status"),
  ).toContainText("3 of 3 confirmed")
  await context.addCookies([
    { name: "cadence-demo-role", value: "recipient", url: origin },
  ])
  await page.evaluate(() => {
    ;(
      window as unknown as { next: { router: { push: (to: string) => void } } }
    ).next.router.push("/me")
  })
  await page.waitForURL("**/me")
  await expect(
    page.getByText("pending", { exact: false }).first(),
  ).toBeVisible()
}

const applyButton = (page: Page) =>
  page.getByRole("button", {
    name: /^(Apply pending|Try again|Preparing…|Checking your last update…)/,
  })

test.describe("apply pending", () => {
  test("a second tab cannot apply while the first is applying, and can once it is done", async ({
    page,
    context,
    watch,
  }) => {
    test.setTimeout(120_000)
    watch.allowStatus(409, /\/accounts\/apply-pending\/confirm$/)
    page.on("dialog", (dialog) => void dialog.accept())

    await signInAs(page, "recipient")
    const origin = new URL(page.url()).origin
    await seedPending(page, context, origin)
    const other = await context.newPage()
    other.on("dialog", (dialog) => void dialog.accept())
    await seedPending(other, context, origin)
    const applies = posts(other, /\/accounts\/apply-pending$/)

    // The first tab starts: it holds the lock before anything has been saved.
    await setMock(page, "slow")
    await page.getByRole("button", { name: "Apply pending" }).click()
    await expect.poll(() => lockHeld(page, "apply-pending")).toBe(true)

    await other.getByRole("button", { name: "Apply pending" }).click()
    await expect(other.getByRole("main").getByRole("alert")).toContainText(
      otherTab("update"),
    )
    expect(applies).toEqual([])

    // The first one finishes; the second can apply its own pending credit.
    await expect(page.getByText("Nothing pending.")).toBeVisible({
      timeout: 60_000,
    })
    await setMock(other, "instant")
    await other.getByRole("button", { name: "Try again" }).click()
    await expect(other.getByText("Nothing pending.")).toBeVisible()
    expect(applies).toHaveLength(1)
  })

  test("a second tab shows the apply the first has sent as being checked, and sends nothing", async ({
    page,
    context,
    watch,
  }) => {
    test.setTimeout(120_000)
    watch.allowStatus(409, /\/accounts\/apply-pending\/confirm$/)
    page.on("dialog", (dialog) => void dialog.accept())

    await signInAs(page, "recipient")
    const origin = new URL(page.url()).origin
    await seedPending(page, context, origin)
    const other = await context.newPage()
    other.on("dialog", (dialog) => void dialog.accept())
    await seedPending(other, context, origin)
    const applies = posts(other, /\/accounts\/apply-pending$/)

    await setMock(page, "slow")
    await page.getByRole("button", { name: "Apply pending" }).click()
    // Saved as it is handed to the network: the second tab sees it without being told.
    await expect
      .poll(() => saved(page, "cadence:submission:apply-pending:"))
      .toHaveLength(1)

    const checking = other.getByRole("button", {
      name: "Checking your last update…",
    })
    await expect(checking).toBeDisabled()
    await expect(other.getByText(otherTab("update"))).toBeVisible()
    expect(applies).toEqual([])

    // Done in the first: the record goes, and the second can apply again.
    await expect(page.getByText("Nothing pending.")).toBeVisible({
      timeout: 60_000,
    })
    await expect(applyButton(other)).toHaveText("Apply pending", {
      timeout: 20_000,
    })
    await expect(other.getByText(otherTab("update"))).toHaveCount(0)
    expect(applies).toEqual([])
  })
})
