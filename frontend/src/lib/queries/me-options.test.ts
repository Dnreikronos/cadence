import {
  InfiniteQueryObserver,
  MutationObserver,
  QueryClient,
} from "@tanstack/react-query"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { createApiClient } from "@/lib/api/client"
import { MOCK_ORIGIN } from "@/lib/api/config"
import { ApiError } from "@/lib/api/errors"
import { ME_PERSON, db, resetDb } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { mockWalletFor } from "@/lib/wallet/mock"
import { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import { queryKeys } from "./keys"
import {
  HISTORY_PAGE_SIZE,
  RECENT_PAYMENTS,
  applyPendingMutation,
  exportPaymentsMutation,
  meQueries,
} from "./me-options"

beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => {
  server.resetHandlers()
  scenarios.clear()
  resetDb()
})
afterAll(() => server.close())

const api = createApiClient({
  baseUrl: MOCK_ORIGIN,
  getToken: async () => "test-token",
})
const queries = meQueries(api)
const viewer = { email: "bruno@solaris.test", company: "Solaris" }

// Bruno already has two seeded payments; this gives him `count` in total.
function receiveUpTo(count: number) {
  const have = db.payments.filter((p) => p.personId === ME_PERSON).length
  for (let i = have; i < count; i++) {
    db.payments.push({
      id: `b1000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      runId: null,
      personId: ME_PERSON,
      amount: 1_000_000n,
      status: "confirmed",
      // One a day, so the order is the same as the insert order.
      paidAt: new Date(Date.UTC(2026, 9, 1 + i, 12)).toISOString(),
      signature: null,
    })
  }
}

describe("meQueries", () => {
  it("keeps the home list and the history out of each other's cache", () => {
    expect(queries.recent().queryKey).not.toEqual(queries.history().queryKey)
    // Both still sit under `payments`, so a payment-changing mutation reaches them.
    for (const key of [queries.recent().queryKey, queries.history().queryKey]) {
      expect(key.slice(0, 1)).toEqual(queryKeys.payments.all)
    }
  })

  it("asks for the latest few payments only", async () => {
    receiveUpTo(30)
    const client = new QueryClient()

    const page = await client.fetchQuery(queries.recent())

    expect(page.items).toHaveLength(RECENT_PAYMENTS)
    // Newest first: the last one inserted (index 29, after the seeded two).
    expect(page.items[0].paid_at).toBe(
      new Date(Date.UTC(2026, 9, 30, 12)).toISOString(),
    )
  })

  it("pages the history until the service has no cursor left", async () => {
    receiveUpTo(2 * HISTORY_PAGE_SIZE + 7)
    const observer = new InfiniteQueryObserver(new QueryClient(), {
      ...queries.history(),
    })

    await observer.fetchNextPage()
    expect(observer.getCurrentResult().data?.pages).toHaveLength(1)
    expect(observer.getCurrentResult().hasNextPage).toBe(true)

    await observer.fetchNextPage()
    await observer.fetchNextPage()
    const { data, hasNextPage } = observer.getCurrentResult()

    expect(data?.pages.map((page) => page.items.length)).toEqual([
      HISTORY_PAGE_SIZE,
      HISTORY_PAGE_SIZE,
      7,
    ])
    expect(hasNextPage).toBe(false)
    const ids = data?.pages.flatMap((page) =>
      page.items.map((p) => p.payment_id),
    )
    expect(new Set(ids).size).toBe(2 * HISTORY_PAGE_SIZE + 7)
  })

  it("has a single page, and no next one, for a short history", async () => {
    const observer = new InfiniteQueryObserver(new QueryClient(), {
      ...queries.history(),
    })

    await observer.fetchNextPage()

    expect(observer.getCurrentResult().data?.pages).toHaveLength(1)
    expect(observer.getCurrentResult().hasNextPage).toBe(false)
  })
})

describe("applyPendingMutation", () => {
  function setup() {
    const queryClient = new QueryClient()
    const onApplied = vi.fn()
    const wallet = mockWalletFor("recipient")
    const options = applyPendingMutation({
      queryClient,
      accounts: api.accounts,
      wallet,
      run: bindSignAndConfirm(wallet),
      onApplied,
    })
    return { queryClient, onApplied, options }
  }

  it("announces the result and refreshes balances and status on success", async () => {
    scenarios.set("instant")
    db.me.pending = 2_000_000n
    const { queryClient, onApplied, options } = setup()
    queryClient.setQueryData(queryKeys.balance.me(viewer), { old: true })
    queryClient.setQueryData(queryKeys.status.me(viewer), { old: true })
    queryClient.setQueryData(queryKeys.people.list(), [])

    await new MutationObserver(queryClient, options).mutate()

    expect(onApplied).toHaveBeenCalledTimes(1)
    expect(
      queryClient.getQueryState(queryKeys.balance.me(viewer))?.isInvalidated,
    ).toBe(true)
    expect(
      queryClient.getQueryState(queryKeys.status.me(viewer))?.isInvalidated,
    ).toBe(true)
    expect(
      queryClient.getQueryState(queryKeys.people.list())?.isInvalidated,
    ).toBe(false)
  })

  it("announces nothing and refreshes nothing when the credit moved", async () => {
    scenarios.set("instant", "credit-mismatch")
    db.me.pending = 2_000_000n
    const { queryClient, onApplied, options } = setup()
    queryClient.setQueryData(queryKeys.balance.me(viewer), { old: true })

    const failure = await new MutationObserver(queryClient, options)
      .mutate()
      .catch((error) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect(onApplied).not.toHaveBeenCalled()
    expect(
      queryClient.getQueryState(queryKeys.balance.me(viewer))?.isInvalidated,
    ).toBe(false)
  })
})

describe("exportPaymentsMutation", () => {
  // Local time, which is what the filename uses.
  const now = () => new Date(2026, 9, 4, 10)

  it("saves the CSV under a dated name and says so", async () => {
    const save = vi.fn()
    const notify = vi.fn()
    const options = exportPaymentsMutation({
      exports: api.exports,
      save,
      notify,
      now,
    })

    await new MutationObserver(new QueryClient(), options).mutate()

    expect(save).toHaveBeenCalledTimes(1)
    const [blob, filename] = save.mock.calls[0]
    expect(filename).toBe("cadence-payments-2026-10-04.csv")
    expect(notify).toHaveBeenCalledWith("Saved cadence-payments-2026-10-04.csv")
    const lines = (await (blob as Blob).text()).split("\n")
    expect(lines[0]).toBe("date,counterparty,amount,status,signature")
    // Bruno's two payments and nobody else's.
    expect(lines).toHaveLength(3)
  })

  it("saves and says nothing when the service refuses", async () => {
    scenarios.set("service-down")
    const save = vi.fn()
    const notify = vi.fn()
    const options = exportPaymentsMutation({
      exports: api.exports,
      save,
      notify,
      now,
    })

    const failure = await new MutationObserver(new QueryClient(), options)
      .mutate()
      .catch((error) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect(save).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})
