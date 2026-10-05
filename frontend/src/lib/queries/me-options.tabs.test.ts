import { MutationObserver, QueryClient } from "@tanstack/react-query"
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
import { db, resetDb } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import type { Acquired } from "@/lib/flow-lock"
import {
  ApplyInProgressError,
  ApplyOtherTabError,
  applyPendingMessage,
} from "@/lib/me/apply-pending"
import { memoryStore } from "@/lib/me/memory-store"
import { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import { mockWalletFor } from "@/lib/wallet/mock"
import { queryKeys } from "./keys"
import { applyPendingMutation } from "./me-options"

beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => {
  vi.restoreAllMocks()
  server.resetHandlers()
  scenarios.clear()
  resetDb()
})
afterAll(() => server.close())

const api = createApiClient({
  baseUrl: MOCK_ORIGIN,
  getToken: async () => "test-token",
})
const viewer = { email: "bruno@solaris.test", company: "Solaris" }
const press = { pendingBefore: "2000000" }

// One tab at a time: the apply takes a lock for its whole run, and a second tab that finds
// it taken, or finds an apply the first tab saved, sends nothing.
function setup(lock: () => Promise<Acquired>) {
  const queryClient = new QueryClient()
  const store = memoryStore()
  const wallet = mockWalletFor("recipient")
  const onSent = vi.fn()
  const options = applyPendingMutation({
    queryClient,
    accounts: api.accounts,
    wallet,
    run: bindSignAndConfirm(wallet),
    store,
    lock,
    onSent,
  })
  const watched = queryKeys.balance.me(viewer)
  queryClient.setQueryData(watched, { old: true })
  return {
    queryClient,
    store,
    onSent,
    options,
    wallet,
    invalidated: () => queryClient.getQueryState(watched)?.isInvalidated,
  }
}

describe("applyPendingMutation across tabs", () => {
  it("refuses when another tab holds the lock: nothing is prepared, saved or refreshed", async () => {
    const prepare = vi.spyOn(api.accounts, "applyPending")
    const { queryClient, options, store, onSent, invalidated } = setup(
      async () => ({ status: "busy" }),
    )

    const failure = await new MutationObserver(queryClient, options)
      .mutate(press)
      .catch((error) => error)

    expect(failure).toBeInstanceOf(ApplyOtherTabError)
    expect(applyPendingMessage(failure)).toBe(
      "Another tab is sending or checking an update for this account: wait for it to finish.",
    )
    expect(prepare).not.toHaveBeenCalled()
    expect(store.read()).toBeNull()
    expect(onSent).not.toHaveBeenCalled()
    expect(invalidated()).toBe(false)
  })

  it("holds the lock until the apply has ended, then releases it", async () => {
    scenarios.set("instant")
    db.me.pending = 2_000_000n
    let released = false
    const { queryClient, options } = setup(async () => ({
      status: "held",
      lease: {
        release: () => {
          released = true
        },
      },
    }))
    const sawHeld: boolean[] = []
    const prepare = api.accounts.applyPending.bind(api.accounts)
    vi.spyOn(api.accounts, "applyPending").mockImplementation(
      async (...args) => {
        sawHeld.push(!released)
        return prepare(...args)
      },
    )

    await new MutationObserver(queryClient, options).mutate(press)

    // Still held when the transaction was prepared, and let go once it was done.
    expect(sawHeld).toEqual([true])
    expect(released).toBe(true)
  })

  it("releases it after a failure too", async () => {
    scenarios.set("service-down")
    db.me.pending = 2_000_000n
    const release = vi.fn()
    const { queryClient, options } = setup(async () => ({
      status: "held",
      lease: { release },
    }))

    await new MutationObserver(queryClient, options)
      .mutate(press)
      .catch(() => {})

    expect(release).toHaveBeenCalledTimes(1)
  })

  it("does not ask for the lock again for a second press in this tab", async () => {
    scenarios.set("instant")
    db.me.pending = 2_000_000n
    const lock = vi.fn(async (): Promise<Acquired> => ({
      status: "held",
      lease: { release: () => {} },
    }))
    const { queryClient, options } = setup(lock)

    const [first, second] = await Promise.allSettled([
      new MutationObserver(queryClient, options).mutate(press),
      new MutationObserver(queryClient, options).mutate(press),
    ])

    expect(first.status).toBe("fulfilled")
    expect(second).toMatchObject({
      status: "rejected",
      reason: expect.any(ApplyInProgressError),
    })
    expect(lock).toHaveBeenCalledTimes(1)
  })

  it("sends nothing when another tab saved an apply while the lock was being asked for, and lets go of the lock", async () => {
    const prepare = vi.spyOn(api.accounts, "applyPending")
    const release = vi.fn()
    const saveTheOtherTabs: { current: () => void } = { current: () => {} }
    const { queryClient, options, store, wallet } = setup(async () => {
      // The other tab sends and saves its record before this one's turn comes.
      saveTheOtherTabs.current()
      return { status: "held", lease: { release } }
    })
    saveTheOtherTabs.current = () =>
      void store.record({
        kind: "apply-pending",
        request_id: "r".repeat(64),
        signature: null,
        last_valid_block_height: 1,
        wallet: wallet.status === "ready" ? wallet.address : "",
      })

    const failure = await new MutationObserver(queryClient, options)
      .mutate(press)
      .catch((error) => error)

    expect(failure).toBeInstanceOf(ApplyInProgressError)
    expect(prepare).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    // The other tab's record is left as it was.
    expect(store.read()).not.toBeNull()
  })

  it("sends it when the lock is held and nothing was saved", async () => {
    scenarios.set("instant")
    db.me.pending = 2_000_000n
    const { queryClient, options } = setup(async () => ({
      status: "held",
      lease: { release: () => {} },
    }))

    const result = await new MutationObserver(queryClient, options).mutate(
      press,
    )

    expect(result.receipt.signature).toBeTruthy()
  })
})
