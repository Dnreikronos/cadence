import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { HttpResponse, http } from "msw"
import { ZodError } from "zod"

const config = vi.hoisted(() => ({ mode: "mock" }))
vi.mock("@/lib/api/mode", () => ({
  apiConfig: {
    get mode() {
      return config.mode
    },
  },
}))

import { createApiClient } from "@/lib/api/client"
import { MOCK_ORIGIN } from "@/lib/api/config"
import { ApiError } from "@/lib/api/errors"
import { ME_WALLET, db, resetAccountStatus, resetDb } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { mockSubmit } from "@/lib/api/mocks/signer"
import { ConfirmTimeoutError } from "@/lib/api/sign"
import { queryKeys } from "@/lib/queries/keys"
import { mockWalletFor } from "@/lib/wallet/mock"
import { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import {
  realModeReason,
  unavailableWallet,
  type Wallet,
} from "@/lib/wallet/types"
import {
  KeyEnrolledElsewhereError,
  StepNotConfirmedError,
  WalletCreationUnavailableError,
  activationMessage,
  isTerminal,
  isWalletUnavailable,
} from "./errors"
import {
  activationReducer,
  doneFromStatus,
  initialState,
  isActivated,
  type ActivationEvent,
  type StepsDone,
} from "./machine"
import { keyDerivationMessage } from "./message"
import { startActivation, type StartGuard } from "./start"
import { createRunners, type ConfigureAttempts } from "./steps"

// The steps against the mock service, through the typed client and `startActivation`:
// what the screen runs, without the React around it.

beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
beforeEach(() => {
  // The mock seeds an activated recipient; these start from a fresh one.
  resetAccountStatus()
})
afterEach(() => {
  vi.restoreAllMocks()
  server.resetHandlers()
  scenarios.clear()
  resetDb()
  config.mode = "mock"
})
afterAll(() => server.close())

const api = createApiClient({
  baseUrl: MOCK_ORIGIN,
  getToken: async () => "test-token",
})

// Confirming asks "not finalized" twice by default; do not wait it out.
function sign(wallet: Wallet, timeoutMs?: number) {
  const run = bindSignAndConfirm(wallet)
  return (...[prepared, confirm, onStep, extra]: Parameters<typeof run>) =>
    run(prepared, confirm, onStep, {
      ...extra,
      sleep: async () => {},
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
}

// One screen: its reducer state, its guard and the button.
async function screen(
  wallet: Wallet,
  {
    attempts = new Map(),
    timeoutMs,
    readStatus = () => api.me.status(),
  }: {
    attempts?: ConfigureAttempts
    timeoutMs?: number
    readStatus?: () => ReturnType<typeof api.me.status>
  } = {},
) {
  let state = initialState(await api.me.status())
  const events: ActivationEvent[] = []
  const guard: StartGuard = { busy: false, controller: null }
  const press = () =>
    startActivation({
      guard,
      done: state.done,
      dispatch: (event) => {
        events.push(event)
        state = activationReducer(state, event)
      },
      readStatus,
      makeRunners: (signal) =>
        createRunners({
          api,
          wallet,
          run: sign(wallet, timeoutMs),
          signal,
          attempts,
        }),
    })
  return {
    press,
    events,
    attempts,
    get state() {
      return state
    },
  }
}

const started = (events: ActivationEvent[]) =>
  events.flatMap((e) => (e.type === "started" ? [e.step] : []))
const none: StepsDone = { wallet: false, key: false, account: false }

const incomplete = (over = {}) =>
  http.get(`${MOCK_ORIGIN}/me/status`, () =>
    HttpResponse.json({
      wallet_linked: true,
      key_enrolled: true,
      account_configured: false,
      pending_credits: false,
      ...over,
    }),
  )

describe("activation against the mock service", () => {
  it("takes a fresh recipient from nothing to set up, and says so only after asking", async () => {
    expect(doneFromStatus(await api.me.status())).toEqual(none)
    const status = vi.spyOn(api.me, "status")
    const s = await screen(mockWalletFor("recipient"))
    status.mockClear()

    await s.press()

    expect(started(s.events)).toEqual(["wallet", "key", "account"])
    expect(s.state.phase).toBe("done")
    expect(await api.me.status()).toMatchObject({
      wallet_linked: true,
      key_enrolled: true,
      account_configured: true,
    })
    // Asked before, after the key step, after the account step, and at the end.
    expect(status.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it("accepts a key the service already holds for this wallet", async () => {
    const wallet = mockWalletFor("recipient")
    await api.keys.enroll(ME_WALLET, "5".repeat(88))
    const enroll = vi.spyOn(api.keys, "enroll")
    const runners = createRunners({
      api,
      wallet,
      run: sign(wallet),
      attempts: new Map(),
    })

    // A lost answer: the device enrolls again, gets the 409, and the status agrees.
    await expect(runners.key()).resolves.toBeUndefined()
    expect(enroll).toHaveBeenCalledOnce()
  })

  it("refuses a 409 while the status says the key is not enrolled, and goes no further", async () => {
    server.use(
      http.post(`${MOCK_ORIGIN}/keys/enroll`, () =>
        HttpResponse.json({ error: "key_already_enrolled" }, { status: 409 }),
      ),
    )
    const configure = vi.spyOn(api.accounts, "configure")
    const s = await screen(mockWalletFor("recipient"))

    await s.press()

    expect(s.state.phase).toBe("failed")
    expect(s.state.failure?.step).toBe("key")
    expect(s.state.failure?.error).toBeInstanceOf(KeyEnrolledElsewhereError)
    expect(isTerminal(s.state.failure?.error)).toBe(true)
    expect(activationMessage(s.state.failure?.error)).toBe(
      "This wallet was set up elsewhere. Contact support.",
    )
    expect(s.state.done.key).toBe(false)
    expect(configure).not.toHaveBeenCalled()
  })

  it("does not call a step done on the service's 200 when the status disagrees", async () => {
    server.use(incomplete({ key_enrolled: false }))
    const wallet = mockWalletFor("recipient")
    const error = await createRunners({
      api,
      wallet,
      run: sign(wallet),
      attempts: new Map(),
    })
      .key()
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StepNotConfirmedError)
    expect(isTerminal(error)).toBe(false)
  })

  it("never ends complete when the last read says it is not, and keeps what it must not repeat", async () => {
    // The service accepts everything but keeps reporting the account as not set up.
    server.use(incomplete())
    const attempts: ConfigureAttempts = new Map()
    const s = await screen(mockWalletFor("recipient"), { attempts })

    await s.press()

    expect(s.state.phase).toBe("failed")
    expect(s.state.failure?.step).toBe("account")
    expect(s.state.failure?.error).toBeInstanceOf(StepNotConfirmedError)
    expect(isActivated(s.state.done)).toBe(false)
    // The transaction went through: a retry must settle it, not prepare another.
    expect(attempts.has(ME_WALLET)).toBe(true)
  })

  it("fails at the account step and resumes there, not at the key", async () => {
    const wallet = mockWalletFor("recipient")
    scenarios.set("tx-failed")
    const attempts: ConfigureAttempts = new Map()
    const s = await screen(wallet, { attempts })
    await s.press()

    expect(s.state.phase).toBe("failed")
    expect(s.state.failure?.step).toBe("account")
    expect(s.state.failure?.error).toBeInstanceOf(ApiError)
    expect(s.state.done).toEqual({ wallet: true, key: true, account: false })
    // The network refused it for good, so the next try may prepare a new one.
    expect(attempts.size).toBe(0)

    scenarios.clear()
    const enroll = vi.spyOn(api.keys, "enroll")
    s.events.length = 0
    await s.press()

    expect(started(s.events)).toEqual(["account"])
    expect(enroll).not.toHaveBeenCalled()
    expect(s.state.phase).toBe("done")
  })

  it("fails at the key step when the service is down, and resumes there", async () => {
    const wallet = mockWalletFor("recipient")
    const s = await screen(wallet, {
      // The status read is down too: the run goes on with what it knows.
      readStatus: () => api.me.status(),
    })
    scenarios.set("service-down")
    await s.press()
    expect(s.state).toMatchObject({
      phase: "failed",
      failure: { step: "key" },
    })
    expect(s.state.done.wallet).toBe(true)

    scenarios.clear()
    s.events.length = 0
    await s.press()
    expect(started(s.events)).toEqual(["key", "account"])
    expect(s.state.phase).toBe("done")
  })

  it("says wallet creation is unavailable in real mode, before asking the service anything", async () => {
    const wallet = unavailableWallet(realModeReason)
    const enroll = vi.spyOn(api.keys, "enroll")
    const configure = vi.spyOn(api.accounts, "configure")
    const s = await screen(wallet)

    await s.press()

    expect(s.state.phase).toBe("failed")
    expect(s.state.failure?.step).toBe("wallet")
    expect(s.state.failure?.error).toBeInstanceOf(
      WalletCreationUnavailableError,
    )
    expect(isWalletUnavailable(s.state.failure?.error)).toBe(true)
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
      createRunners({
        api,
        wallet,
        run: sign(wallet),
        attempts: new Map(),
      }).key(),
    ).rejects.toSatisfy(isWalletUnavailable)
    expect(enroll).not.toHaveBeenCalled()
  })

  it("runs one setup at a time: a second press while one runs does nothing", async () => {
    const enroll = vi.spyOn(api.keys, "enroll")
    const configure = vi.spyOn(api.accounts, "configure")
    const s = await screen(mockWalletFor("recipient"))

    await Promise.all([s.press(), s.press(), s.press()])

    expect(enroll).toHaveBeenCalledOnce()
    expect(configure).toHaveBeenCalledOnce()
    expect(s.state.phase).toBe("done")
  })
})

describe("a configure that was submitted", () => {
  // Confirming waits out its 60 s with no sleeping: a timeout of zero gives up at once.
  async function timedOut() {
    const wallet = mockWalletFor("recipient")
    const attempts: ConfigureAttempts = new Map()
    const s = await screen(wallet, { attempts, timeoutMs: 0 })
    await s.press()
    expect(s.state.failure?.step).toBe("account")
    expect(s.state.failure?.error).toBeInstanceOf(ConfirmTimeoutError)
    return { wallet, attempts, s }
  }

  it("keeps the transaction, and says it may have gone through, with no new one prepared", async () => {
    const { attempts, s } = await timedOut()
    expect(attempts.get(ME_WALLET)).toMatchObject({
      request_id: expect.stringMatching(/^[0-9a-f]{64}$/),
      signature: expect.stringMatching(/^MockSignature/),
    })
    expect(activationMessage(s.state.failure?.error)).toMatch(
      /may already have gone through/,
    )
  })

  it("finishes, without preparing again, when the status now says it is configured", async () => {
    const { wallet, attempts } = await timedOut()
    // The transaction landed while this device was waiting.
    db.accountConfigured = true
    db.walletLinked = true
    const configure = vi.spyOn(api.accounts, "configure")
    const confirm = vi.spyOn(api.accounts, "confirmConfigure")

    await createRunners({
      api,
      wallet,
      run: sign(wallet),
      attempts,
    }).account()

    expect(configure).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(attempts.size).toBe(0)
  })

  it("skips the step at the next press when the status says it is done", async () => {
    const { wallet, attempts, s } = await timedOut()
    db.accountConfigured = true
    db.walletLinked = true
    const configure = vi.spyOn(api.accounts, "configure")
    // A new screen: the same attempts, as after leaving and coming back.
    const again = await screen(wallet, { attempts })
    await again.press()
    expect(configure).not.toHaveBeenCalled()
    expect(again.state.phase).toBe("done")
    void s
  })

  it("confirms the same request and signature again when it is not configured, then finishes", async () => {
    const { wallet, attempts } = await timedOut()
    const submitted = attempts.get(ME_WALLET)
    scenarios.set("instant")
    const configure = vi.spyOn(api.accounts, "configure")
    const confirm = vi.spyOn(api.accounts, "confirmConfigure")

    await createRunners({
      api,
      wallet,
      run: sign(wallet),
      attempts,
    }).account()

    expect(configure).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0]).toEqual(submitted)
    expect(attempts.size).toBe(0)
    expect((await api.me.status()).account_configured).toBe(true)
  })

  it("still cannot settle: says so again, keeps the transaction, prepares nothing", async () => {
    const { wallet, attempts } = await timedOut()
    const submitted = attempts.get(ME_WALLET)
    const configure = vi.spyOn(api.accounts, "configure")

    // The mock answers "not finalized" twice per request; this is the second ask.
    const error = await createRunners({
      api,
      wallet,
      run: sign(wallet),
      attempts,
    })
      .account()
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConfirmTimeoutError)
    expect(configure).not.toHaveBeenCalled()
    expect(attempts.get(ME_WALLET)).toEqual(submitted)
  })

  it("keeps the transaction when the person leaves right after it was submitted", async () => {
    const ready = mockWalletFor("recipient")
    const controller = new AbortController()
    const wallet: Wallet = {
      ...ready,
      submit: async (signed) => {
        const signature = await mockSubmit()
        void signed
        controller.abort(new Error("left"))
        return signature
      },
    }
    const attempts: ConfigureAttempts = new Map()
    const configure = vi.spyOn(api.accounts, "configure")

    await expect(
      createRunners({
        api,
        wallet,
        run: sign(wallet),
        signal: controller.signal,
        attempts,
      }).account(),
    ).rejects.toThrow("left")
    expect(attempts.size).toBe(1)
    expect(configure).toHaveBeenCalledOnce()

    // They come back: that transaction is settled, a new one is not prepared.
    scenarios.set("instant")
    await createRunners({
      api,
      wallet: ready,
      run: sign(ready),
      attempts,
    }).account()
    expect(configure).toHaveBeenCalledOnce()
    expect((await api.me.status()).account_configured).toBe(true)
  })
})

describe("the key-derivation signature", () => {
  const equal = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i])

  it("only ever signs the derivation message for this wallet", async () => {
    const wallet = mockWalletFor("recipient")
    const signMessage = vi.spyOn(wallet.signer, "signMessage")
    const s = await screen(wallet)

    await s.press()

    expect(signMessage).toHaveBeenCalledOnce()
    const expected = keyDerivationMessage(ME_WALLET)
    for (const [message] of signMessage.mock.calls) {
      expect(equal(message, expected)).toBe(true)
    }
  })

  // Run a whole setup, failing at the end, and look everywhere a value could stick.
  async function leaks(failWith: "tx-failed" | "ok") {
    const queryClient = new QueryClient()
    const viewer = { email: "bruno@solaris.test", company: "Solaris" }
    const readStatus = () =>
      queryClient.fetchQuery({
        queryKey: queryKeys.status.me(viewer),
        queryFn: () => api.me.status(),
        staleTime: 0,
      })
    const wallet = mockWalletFor("recipient")
    const enroll = vi.spyOn(api.keys, "enroll")
    const consoleCalls: unknown[][] = []
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => {
        consoleCalls.push(args)
      })
    }
    if (failWith === "tx-failed") scenarios.set("tx-failed")
    const s = await screen(wallet, { readStatus })

    await s.press()

    const signature = String(enroll.mock.calls[0][1])
    expect(signature.length).toBeGreaterThan(40)
    const dump = (value: unknown) =>
      JSON.stringify(value, (_, v: unknown) =>
        v instanceof Error
          ? { ...v, name: v.name, message: v.message, stack: v.stack }
          : v,
      )
    const surfaces = {
      state: dump(s.state),
      queries: dump(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => ({ key: q.queryKey, state: q.state })),
      ),
      mutations: dump(
        queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      ),
      console: dump(consoleCalls),
      message: s.state.failure ? activationMessage(s.state.failure.error) : "",
    }
    return { signature, surfaces, queryClient, s }
  }

  it.each(["ok", "tx-failed"] as const)(
    "is in no state, cache, console call or message (%s)",
    async (failWith) => {
      const { signature, surfaces, queryClient } = await leaks(failWith)
      for (const [where, text] of Object.entries(surfaces)) {
        expect(text, where).not.toContain(signature)
      }
      // The caches were really read: this is not an empty dump passing by default.
      expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0)
      expect(surfaces.queries).toContain("wallet_linked")
    },
  )

  it("fails on a signature of the wrong length before anything is sent, without echoing it", async () => {
    const ready = mockWalletFor("recipient")
    const short = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    const wallet: Wallet = {
      ...ready,
      signer: { ...ready.signer, signMessage: async () => short.slice() },
    }
    const requested: string[] = []
    server.events.on("request:start", ({ request }) => {
      requested.push(new URL(request.url).pathname)
    })
    const error = await createRunners({
      api,
      wallet,
      run: sign(wallet),
      attempts: new Map(),
    })
      .key()
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ZodError)
    expect(requested).not.toContain("/keys/enroll")
    const text = JSON.stringify(error, Object.getOwnPropertyNames(error))
    expect(text).not.toMatch(/Ldsh|2VfUX|1,2,3/)
    expect(activationMessage(error)).toBe("Something went wrong. Try again.")
    server.events.removeAllListeners()
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
