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
import { mockWalletFor } from "@/lib/wallet/mock"
import { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import { unavailableWallet, WalletUnavailableError } from "@/lib/wallet/types"
import { applyPending, applyPendingMessage } from "./apply-pending"

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

function deps(wallet = mockWalletFor("recipient")) {
  return { accounts: api.accounts, wallet, run: bindSignAndConfirm(wallet) }
}

describe("applyPending", () => {
  it("signs and confirms, which moves pending credits to available", async () => {
    scenarios.set("instant")
    db.me.available = 8_000_000_000n
    db.me.pending = 1_500_000n
    const steps: string[] = []

    await applyPending(deps(), (step) => steps.push(step))

    expect(steps).toEqual(["signing", "submitting", "confirming"])
    expect(db.me.pending).toBe(0n)
    expect(db.me.available).toBe(8_001_500_000n)
  })

  it("surfaces credit_counter_mismatch and leaves the balance as it was", async () => {
    scenarios.set("instant", "credit-mismatch")
    db.me.pending = 1_500_000n

    const failure = await applyPending(deps()).catch((error) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure.code).toBe("credit_counter_mismatch")
    expect(db.me.pending).toBe(1_500_000n)
    // The message tells the person to try again, in words.
    expect(applyPendingMessage(failure)).toBe(
      "A payment arrived while we were updating your balance. Try again.",
    )
  })

  it("works again after a mismatch", async () => {
    scenarios.set("instant", "credit-mismatch")
    db.me.pending = 1_500_000n
    await expect(applyPending(deps())).rejects.toBeInstanceOf(ApiError)

    scenarios.set("instant")
    await applyPending(deps())

    expect(db.me.pending).toBe(0n)
  })

  it("asks the service nothing when the wallet cannot sign", async () => {
    const prepare = vi.fn()
    const wallet = unavailableWallet("auditors do not hold a wallet")

    await expect(
      applyPending({
        accounts: { ...api.accounts, applyPending: prepare },
        wallet,
        run: bindSignAndConfirm(wallet),
      }),
    ).rejects.toBeInstanceOf(WalletUnavailableError)

    expect(prepare).not.toHaveBeenCalled()
  })
})

describe("applyPendingMessage", () => {
  it("says what happened for each way the flow can stop", () => {
    expect(applyPendingMessage(new WalletUnavailableError("#78"))).toBe(
      "Your wallet can't sign here yet.",
    )
    expect(applyPendingMessage(new ConfirmTimeoutError("sig"))).toMatch(
      /hasn't confirmed this yet/,
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
  })

  it("never shows the text of an error it does not know", () => {
    const message = applyPendingMessage(new Error("secret 4200000000 units"))
    expect(message).not.toMatch(/secret|4200000000/)
    expect(message).toMatch(/Try again/)
  })
})
