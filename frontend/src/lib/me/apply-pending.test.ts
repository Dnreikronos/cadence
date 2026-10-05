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
import { ConfirmTimeoutError, UnexpectedSignerError } from "@/lib/api/sign"
import type { Submission } from "@/lib/submissions"
import { memoryStore } from "./memory-store"
import {
  StorageUnavailableError,
  storageBlockedMessage,
} from "@/lib/storage-guard"
import { mockWalletFor } from "@/lib/wallet/mock"
import { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import {
  unavailableWallet,
  WalletUnavailableError,
  type Wallet,
} from "@/lib/wallet/types"
import {
  ApplyInProgressError,
  APPLY_KIND,
  SentApplyError,
  applyPending,
  applyPendingMessage,
  sentMessage,
  type ApplyPhase,
} from "./apply-pending"

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

function deps(wallet: Wallet = mockWalletFor("recipient")) {
  const store = memoryStore()
  return {
    store,
    accounts: api.accounts,
    wallet,
    run: bindSignAndConfirm(wallet),
  }
}

const failing = (error: unknown): Wallet => ({
  ...mockWalletFor("recipient"),
  submit: async () => {
    throw error
  },
})

describe("applyPending without a way to keep a record", () => {
  const blocked = () => {
    throw new StorageUnavailableError()
  }

  it("prepares nothing when it cannot start, and says why", async () => {
    const d = deps()
    const prepare = vi.spyOn(d.accounts, "applyPending")
    const failure = await applyPending({ ...d, requireStorage: blocked }).catch(
      (e) => e,
    )
    expect(failure).toBeInstanceOf(StorageUnavailableError)
    expect(prepare).not.toHaveBeenCalled()
    expect(applyPendingMessage(failure)).toBe(storageBlockedMessage)
    expect(d.store.read()).toBeNull()
  })

  it("stops before the send when the record cannot be kept, and is not a sent failure", async () => {
    const d = deps()
    const submit = vi.fn(async () => "never")
    const wallet = { ...mockWalletFor("recipient"), submit } as Wallet
    let calls = 0
    const failure = await applyPending({
      ...d,
      wallet,
      run: bindSignAndConfirm(wallet),
      requireStorage: () => {
        if (++calls > 1) blocked()
      },
    }).catch((e) => e)
    expect(submit).not.toHaveBeenCalled()
    expect(failure).toBeInstanceOf(StorageUnavailableError)
    expect(failure).not.toBeInstanceOf(SentApplyError)
    // Nothing was sent, so nothing is left to look up.
    expect(d.store.read()).toBeNull()
  })

  it("goes on when the check passes", async () => {
    scenarios.set("instant")
    const requireStorage = vi.fn()
    await applyPending({ ...deps(), requireStorage })
    expect(requireStorage).toHaveBeenCalledTimes(2)
  })
})

describe("applyPending", () => {
  it("signs and confirms, which moves pending credits to available", async () => {
    scenarios.set("instant")
    db.me.available = 8_000_000_000n
    db.me.pending = 1_500_000n
    const phases: ApplyPhase[] = []

    const receipt = await applyPending(deps(), (phase) => phases.push(phase))

    expect(phases).toEqual(["preparing", "signing", "submitting", "confirming"])
    expect(receipt.status).toBe("finalized")
    expect(db.me.pending).toBe(0n)
    expect(db.me.available).toBe(8_001_500_000n)
  })

  it("keeps a record from the submit until it is confirmed, then drops it", async () => {
    scenarios.set("instant")
    db.me.pending = 1_500_000n
    const d = deps()
    const seen: (Submission | null)[] = []
    const phases = (phase: ApplyPhase) => {
      // Looked at the moment the transaction is handed to the network.
      if (phase === "confirming") seen.push(d.store.read())
    }

    await applyPending({ ...d, now: () => 1234 }, phases)

    expect(seen[0]).toMatchObject({
      kind: APPLY_KIND,
      wallet: d.wallet.address,
      at: 1234,
    })
    expect(seen[0]?.signature).toEqual(expect.any(String))
    expect(d.store.read()).toBeNull()
  })

  it("is a sent failure when the service says credit_counter_mismatch, and the apply did land", async () => {
    scenarios.set("instant", "credit-mismatch")
    db.me.available = 8_000_000_000n
    db.me.pending = 1_500_000n
    const d = deps()

    const failure = await applyPending(d).catch((error) => error)

    expect(failure).toBeInstanceOf(SentApplyError)
    expect(failure.cause).toMatchObject({ code: "credit_counter_mismatch" })
    expect(failure.signature).toEqual(expect.any(String))
    // The service compares the counter after the apply: the credit moved anyway.
    expect(db.me.pending).toBe(0n)
    expect(db.me.available).toBe(8_001_500_000n)
    // Kept, with the signature, so it can be confirmed again and never prepared again.
    expect(d.store.read()?.signature).toBe(failure.signature)
    expect(applyPendingMessage(failure)).toBe(sentMessage)
    expect(sentMessage).not.toMatch(/try again/i)
  })

  it("is a sent failure, with no signature, when submit throws", async () => {
    scenarios.set("instant")
    const d = deps(failing(new TypeError("Failed to fetch")))

    const failure = await applyPending(d).catch((error) => error)

    expect(failure).toBeInstanceOf(SentApplyError)
    expect(failure.signature).toBeNull()
    expect(d.store.read()).toMatchObject({ signature: null })
  })

  it("is a sent failure when something other than an ApiError is thrown after the submit", async () => {
    scenarios.set("instant")
    const d = deps()
    d.accounts = {
      ...api.accounts,
      confirmApplyPending: async () => {
        throw new Error("secret 4200000000 units")
      },
    }

    const failure = await applyPending(d).catch((error) => error)

    expect(failure).toBeInstanceOf(SentApplyError)
    expect(failure.signature).toEqual(expect.any(String))
    expect(applyPendingMessage(failure)).not.toMatch(/secret|4200000000/)
  })

  it("is a sent failure when the network never confirms, and keeps the signature", async () => {
    const d = deps()
    d.run = async (_prepared, _confirm, onStep, extra) => {
      onStep?.("signing")
      onStep?.("submitting")
      extra?.onSubmitted?.("sig-on-the-network")
      throw new ConfirmTimeoutError("sig-on-the-network")
    }

    const failure = await applyPending(d).catch((error) => error)

    expect(failure).toBeInstanceOf(SentApplyError)
    expect(failure.signature).toBe("sig-on-the-network")
    expect(d.store.read()?.signature).toBe("sig-on-the-network")
    expect(applyPendingMessage(failure)).toBe(sentMessage)
  })

  it("is a sent failure for transaction_mismatch and a 500 on confirm", async () => {
    for (const status of [409, 500]) {
      scenarios.set("instant")
      const d = deps()
      d.accounts = {
        ...api.accounts,
        confirmApplyPending: async () => {
          throw new ApiError(
            status,
            status === 409 ? "transaction_mismatch" : "internal_error",
          )
        },
      }
      await expect(applyPending(d)).rejects.toBeInstanceOf(SentApplyError)
      expect(d.store.read()).not.toBeNull()
    }
  })

  it("is not sent when the network says the transaction failed: trying again is fine", async () => {
    scenarios.set("instant", "tx-failed")
    const d = deps()

    const failure = await applyPending(d).catch((error) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure.code).toBe("transaction_failed")
    expect(d.store.read()).toBeNull()
  })

  it("is not sent when prepare fails", async () => {
    scenarios.set("service-down")
    const d = deps()

    const failure = await applyPending(d).catch((error) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).not.toBeInstanceOf(SentApplyError)
    expect(d.store.read()).toBeNull()
  })

  it("is not sent when the person refuses to sign", async () => {
    scenarios.set("instant")
    const wallet = mockWalletFor("recipient")
    const d = deps({
      ...wallet,
      signer: {
        ...wallet.signer,
        signTransaction: async () => {
          throw new Error("User rejected the request")
        },
      },
    })

    const failure = await applyPending(d).catch((error) => error)

    expect(failure).not.toBeInstanceOf(SentApplyError)
    expect(failure.message).toMatch(/rejected/)
    expect(d.store.read()).toBeNull()
  })

  it("asks the service nothing when the wallet cannot sign", async () => {
    const prepare = vi.fn()
    const wallet = unavailableWallet("auditors do not hold a wallet")
    const d = deps(wallet)
    d.accounts = { ...api.accounts, applyPending: prepare }

    await expect(applyPending(d)).rejects.toBeInstanceOf(WalletUnavailableError)

    expect(prepare).not.toHaveBeenCalled()
  })
})

describe("applyPendingMessage", () => {
  it("says what happened for each way the flow can stop", () => {
    expect(applyPendingMessage(new WalletUnavailableError("#78"))).toBe(
      "Your wallet can't sign here yet.",
    )
    expect(applyPendingMessage(new UnexpectedSignerError())).toMatch(
      /wasn't prepared for your wallet/,
    )
    expect(applyPendingMessage(new ApiError(409, "transaction_failed"))).toBe(
      "The network rejected the transaction.",
    )
    expect(
      applyPendingMessage(new ApiError(503, "service_unavailable")),
    ).toMatch(/unavailable right now/)
    expect(applyPendingMessage(new ApplyInProgressError())).toMatch(
      /already in progress/,
    )
  })

  it("says only that a sent apply may have gone through, never to try again", () => {
    for (const cause of [
      new ApiError(409, "credit_counter_mismatch"),
      new ConfirmTimeoutError("sig"),
      new TypeError("Failed to fetch"),
    ]) {
      expect(applyPendingMessage(new SentApplyError(null, cause))).toBe(
        sentMessage,
      )
    }
    expect(sentMessage).toMatch(/may already have gone through/)
  })

  it("never shows the text of an error it does not know", () => {
    const message = applyPendingMessage(new Error("secret 4200000000 units"))
    expect(message).not.toMatch(/secret|4200000000/)
    expect(message).toMatch(/Try again/)
  })
})
