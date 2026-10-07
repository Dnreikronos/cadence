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
import { db, resetDb } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { mockBlockHeight } from "@/lib/api/mocks/chain"
import { mockWalletFor } from "@/lib/wallet/mock"
import { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import { applyPending, SentApplyError } from "./apply-pending"
import { checkLastApply, lastApplyMessage, sentApply } from "./last-apply"
import { memoryStore } from "./memory-store"

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
const wallet = mockWalletFor("recipient")

// An apply whose outcome is unknown, as a page that was left leaves it.
async function leaveMidApply(
  store: ReturnType<typeof memoryStore>,
  withWallet = wallet,
) {
  const failure = await applyPending({
    store,
    accounts: api.accounts,
    wallet: withWallet,
    run: bindSignAndConfirm(withWallet),
    now: () => 1_000,
  }).catch((error) => error)
  expect(failure).toBeInstanceOf(SentApplyError)
  return failure as SentApplyError
}

const noWait = { sleep: async () => {}, pollMs: 0 }

describe("checkLastApply", () => {
  it("asks nothing when no apply was sent", async () => {
    const confirm = vi.fn()
    const outcome = await checkLastApply({
      store: memoryStore(),
      wallet: wallet.address,
      accounts: { confirmApplyPending: confirm },
      refresh: vi.fn(),
    })
    expect(outcome).toBe("none")
    expect(confirm).not.toHaveBeenCalled()
  })

  it("ignores a record that belongs to another wallet", async () => {
    scenarios.set("instant", "credit-mismatch")
    db.me.pending = 1_000_000n
    const store = memoryStore()
    await leaveMidApply(store)
    expect(sentApply(store, "someone-else")).toBeNull()
    const confirm = vi.fn()
    expect(
      await checkLastApply({
        store,
        wallet: "someone-else",
        accounts: { confirmApplyPending: confirm },
        refresh: vi.fn(),
      }),
    ).toBe("none")
    expect(confirm).not.toHaveBeenCalled()
    expect(store.read()).not.toBeNull()
  })

  it("finds the apply that landed after a mismatch, with a fresh mount, by confirming again", async () => {
    scenarios.set("instant", "credit-mismatch")
    db.me.pending = 1_000_000n
    const store = memoryStore()
    await leaveMidApply(store)
    // The reload: nothing in memory, only what the store kept. The service now
    // answers normally.
    scenarios.set("instant")
    const prepare = vi.spyOn(api.accounts, "applyPending")
    const refresh = vi.fn()

    const outcome = await checkLastApply({
      store,
      wallet: wallet.address,
      accounts: api.accounts,
      refresh,
      ...noWait,
    })

    expect(outcome).toBe("confirmed")
    // Nothing new was prepared, and the lock is gone.
    expect(prepare).not.toHaveBeenCalled()
    expect(store.read()).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("reads a dropped transaction as one that did not go through", async () => {
    scenarios.set("instant", "credit-mismatch")
    db.me.pending = 1_000_000n
    const store = memoryStore()
    await leaveMidApply(store)

    const outcome = await checkLastApply({
      store,
      wallet: wallet.address,
      accounts: {
        confirmApplyPending: async () => {
          throw new ApiError(409, "transaction_failed")
        },
      },
      refresh: vi.fn(),
      ...noWait,
    })

    expect(outcome).toBe("failed")
    expect(store.read()).toBeNull()
  })

  it("keeps waiting for an apply with no signature until a transaction can no longer land", async () => {
    // `submit` threw: the network may have it, and there is nothing to ask about.
    const store = memoryStore()
    const gone = {
      ...wallet,
      submit: async () => {
        throw new TypeError("Failed to fetch")
      },
    }
    scenarios.set("instant")
    const failure = await leaveMidApply(store, gone)
    expect(failure.signature).toBeNull()
    const confirm = vi.fn()
    const lastValid = store.read()!.last_valid_block_height
    // The mock chain, on a clock that moves only when the check waits: 10 s in.
    let clock = Date.now() + 10_000
    const sleep = vi.fn(async (ms: number) => {
      clock += ms
    })

    const outcome = await checkLastApply({
      store,
      wallet: wallet.address,
      accounts: { confirmApplyPending: confirm },
      refresh: vi.fn(),
      blockHeight: async () => mockBlockHeight(clock),
      sleep,
    })

    expect(outcome).toBe("unknown")
    expect(confirm).not.toHaveBeenCalled()
    // It waited until the chain was past the apply's last valid block, not less.
    expect(mockBlockHeight(clock)).toBeGreaterThan(lastValid)
    expect(mockBlockHeight(clock - 3_000)).toBeLessThanOrEqual(lastValid)
    expect(store.read()).toBeNull()
  })

  it("keeps the record and throws when the service cannot be asked", async () => {
    scenarios.set("instant", "credit-mismatch")
    db.me.pending = 1_000_000n
    const store = memoryStore()
    await leaveMidApply(store)

    await expect(
      checkLastApply({
        store,
        wallet: wallet.address,
        accounts: {
          confirmApplyPending: async () => {
            throw new Error("a bug, not an answer")
          },
        },
        refresh: vi.fn(),
        ...noWait,
      }),
    ).rejects.toThrow()

    expect(store.read()).not.toBeNull()
  })
})

describe("lastApplyMessage", () => {
  it("says what the check found", () => {
    expect(lastApplyMessage("confirmed")).toMatch(/went through/)
    expect(lastApplyMessage("failed")).toMatch(/didn't go through/)
    expect(lastApplyMessage("unknown")).toMatch(/couldn't tell/)
    expect(lastApplyMessage("none")).toBeNull()
  })
})
