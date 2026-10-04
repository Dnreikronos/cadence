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
import { ME_WALLET, db, resetDb } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { mockWalletFor } from "@/lib/wallet/mock"
import { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import {
  realModeReason,
  unavailableWallet,
  type Wallet,
} from "@/lib/wallet/types"
import {
  WalletCreationUnavailableError,
  activationMessage,
  isWalletUnavailable,
} from "./errors"
import {
  activationReducer,
  doneFromStatus,
  initialState,
  isActivated,
  runActivation,
  type ActivationEvent,
  type ActivationState,
} from "./machine"
import { createRunners } from "./steps"

// The three steps against the mock service, through the typed client: what the
// screen runs, without the React around it.

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

// Confirming asks "not finalized" twice by default; do not wait it out.
function sign(wallet: Wallet) {
  const run = bindSignAndConfirm(wallet)
  const spy = vi.fn(
    (...[prepared, confirm, onStep, extra]: Parameters<typeof run>) =>
      run(prepared, confirm, onStep, { ...extra, sleep: async () => {} }),
  )
  return spy
}

// One press of the button, as the hook does it: what the service says is done now,
// merged into what this device has done, then the steps still to do.
async function start(state: ActivationState, wallet: Wallet) {
  let current = activationReducer(state, { type: "begun" })
  const events: ActivationEvent[] = []
  const dispatch = (event: ActivationEvent) => {
    events.push(event)
    current = activationReducer(current, event)
  }
  dispatch({ type: "synced", done: doneFromStatus(await api.me.status()) })
  await runActivation({
    done: current.done,
    runners: createRunners({ api, wallet, run: sign(wallet) }),
    dispatch,
  })
  return { state: current, events }
}

const fresh = async () => initialState(await api.me.status())
const started = (events: ActivationEvent[]) =>
  events.flatMap((e) => (e.type === "started" ? [e.step] : []))

describe("activation against the mock service", () => {
  it("takes a fresh recipient from nothing to set up", async () => {
    expect(await api.me.status()).toEqual({
      wallet_linked: false,
      key_enrolled: false,
      account_configured: false,
      pending_credits: false,
    })

    const { state, events } = await start(
      await fresh(),
      mockWalletFor("recipient"),
    )

    expect(started(events)).toEqual(["wallet", "key", "account"])
    expect(state.phase).toBe("done")
    expect(await api.me.status()).toMatchObject({
      wallet_linked: true,
      key_enrolled: true,
      account_configured: true,
    })
  })

  it("treats a key that is already enrolled as done, and goes on to the account", async () => {
    const wallet = mockWalletFor("recipient")
    // Enrolled by an earlier try whose answer never reached this device.
    await api.keys.enroll(ME_WALLET, "5".repeat(88))
    const enroll = vi.spyOn(api.keys, "enroll")

    // The device does not know that: it starts from the key step.
    const { state, events } = await start(
      {
        ...(await fresh()),
        done: { wallet: true, key: false, account: false },
      },
      wallet,
    )

    expect(started(events)).toEqual(["account"])
    expect(enroll).not.toHaveBeenCalled()
    expect(state.phase).toBe("done")
  })

  it("accepts a 409 key_already_enrolled from the enroll call itself", async () => {
    const wallet = mockWalletFor("recipient")
    await api.keys.enroll(ME_WALLET, "5".repeat(88))
    // A stale status that still says "not enrolled", like a lost answer.
    const runners = createRunners({ api, wallet, run: sign(wallet) })

    await expect(runners.key()).resolves.toBeUndefined()
    expect(db.enrolled.has(ME_WALLET)).toBe(true)
  })

  it("sends the signature of the derivation message, base58, and only to the enroll route", async () => {
    const wallet = mockWalletFor("recipient")
    const enroll = vi.spyOn(api.keys, "enroll")
    const signMessage = vi.spyOn(wallet.signer, "signMessage")

    await createRunners({ api, wallet, run: sign(wallet) }).key()

    expect(signMessage).toHaveBeenCalledOnce()
    const [address, signature] = enroll.mock.calls[0]
    expect(address).toBe(ME_WALLET)
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,88}$/)
  })

  it("keeps the signature out of the failure it reports", async () => {
    const wallet = mockWalletFor("recipient")
    const enroll = vi.spyOn(api.keys, "enroll")
    scenarios.set("service-down")

    const error = await createRunners({ api, wallet, run: sign(wallet) })
      .key()
      .catch((e: unknown) => e)

    const signature = String(enroll.mock.calls[0][1])
    expect(signature.length).toBeGreaterThan(40)
    expect(error).toBeInstanceOf(ApiError)
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ).not.toContain(signature)
    expect(activationMessage(error)).not.toContain(signature)
  })

  it("fails at the account step and resumes there, not at the key", async () => {
    const wallet = mockWalletFor("recipient")
    scenarios.set("tx-failed")
    const first = await start(await fresh(), wallet)

    expect(first.state.phase).toBe("failed")
    expect(first.state.failure?.step).toBe("account")
    expect(first.state.failure?.error).toBeInstanceOf(ApiError)
    expect(first.state.done).toEqual({
      wallet: true,
      key: true,
      account: false,
    })

    scenarios.clear()
    const enroll = vi.spyOn(api.keys, "enroll")
    const second = await start(first.state, wallet)

    expect(started(second.events)).toEqual(["account"])
    expect(enroll).not.toHaveBeenCalled()
    expect(second.state.phase).toBe("done")
    expect(isActivated(second.state.done)).toBe(true)
  })

  it("fails at the key step when the service is down, and resumes there", async () => {
    const wallet = mockWalletFor("recipient")
    const opened = await fresh()
    scenarios.set("service-down")
    // Status cannot be read either: the device goes on with what it knows.
    let current = activationReducer(opened, { type: "begun" })
    await runActivation({
      done: current.done,
      runners: createRunners({ api, wallet, run: sign(wallet) }),
      dispatch: (event) => {
        current = activationReducer(current, event)
      },
    })
    expect(current).toMatchObject({
      phase: "failed",
      failure: { step: "key" },
    })
    expect(current.done.wallet).toBe(true)

    scenarios.clear()
    const retry = await start(current, wallet)
    expect(started(retry.events)).toEqual(["key", "account"])
    expect(retry.state.phase).toBe("done")
  })

  it("skips the account step when the service already configured it", async () => {
    const wallet = mockWalletFor("recipient")
    // The configure transaction landed, but this device timed out waiting.
    const failed = activationReducer(
      activationReducer(
        {
          ...(await fresh()),
          done: { wallet: true, key: true, account: false },
        },
        { type: "begun" },
      ),
      { type: "failed", step: "account", error: new Error("timeout") },
    )
    db.accountConfigured = true
    db.walletLinked = true

    const retry = await start(failed, wallet)

    expect(started(retry.events)).toEqual([])
    expect(retry.state.phase).toBe("done")
  })

  it("says wallet creation is unavailable in real mode, before asking the service anything", async () => {
    const wallet = unavailableWallet(realModeReason)
    const enroll = vi.spyOn(api.keys, "enroll")
    const configure = vi.spyOn(api.accounts, "configure")

    const { state } = await start(await fresh(), wallet)

    expect(state.phase).toBe("failed")
    expect(state.failure?.step).toBe("wallet")
    expect(state.failure?.error).toBeInstanceOf(WalletCreationUnavailableError)
    expect(isWalletUnavailable(state.failure?.error)).toBe(true)
    expect(enroll).not.toHaveBeenCalled()
    expect(configure).not.toHaveBeenCalled()
  })

  it("does not sign when the wallet cannot sign messages", async () => {
    const ready = mockWalletFor("recipient")
    const wallet: Wallet = {
      ...ready,
      signer: {
        address: ready.address,
        signTransaction: ready.signer.signTransaction,
      },
    }
    const enroll = vi.spyOn(api.keys, "enroll")

    await expect(
      createRunners({ api, wallet, run: sign(wallet) }).key(),
    ).rejects.toSatisfy(isWalletUnavailable)
    expect(enroll).not.toHaveBeenCalled()
  })
})

describe("what a failure shows", () => {
  it("gives copy for the service's code, never the thrown message", () => {
    expect(activationMessage(new ApiError(409, "transaction_failed"))).toBe(
      "The network rejected the transaction.",
    )
    const leaky = new Error("signature 5abc was rejected")
    expect(activationMessage(leaky)).toBe("Something went wrong. Try again.")
    expect(activationMessage(leaky)).not.toContain("5abc")
  })
})
