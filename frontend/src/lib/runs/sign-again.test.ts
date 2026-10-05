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
import type { RunCreated } from "@/lib/api/schemas"
import { signAndConfirm, type Signer } from "@/lib/api/sign"
import { COMPANY_WALLET, db, resetDb, seedPeople } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { mockSigner, mockSubmit } from "@/lib/api/mocks/signer"
import { payOne, type RunApi, type RunContext } from "./executor"
import { createHeldStore, heldMaxAgeMs, keepsHeld } from "./held"
import { cancelledStaleMessage } from "./messages"
import { holdingRetries, runEvents, signAgain } from "./sign-again"
import {
  canRecheck,
  canRetry,
  canSignAgain,
  localReducer,
  mergeRow,
  type LocalAction,
  type LocalRows,
} from "./progress"
import { isSignatureRejection } from "./errors"

// A signature the admin cancels, against the real signing flow and the mock service:
// nothing was sent, so the same prepared transaction is signed again. It is never
// answered by `runs.retryPayment` (the service allows that only for a payment that
// failed or expired) or by a second `runs.create`.

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

const [bruno, , diego] = seedPeople
const payees = [
  { person_id: bruno.id, amount: "4200000000" },
  { person_id: diego.id, amount: "6300000000" },
]

const refusal = () =>
  Object.assign(new Error("denied"), { name: "UserRejectedRequestError" })

// The hook's own wiring (`runEvents`, `holdingRetries`, `signAgain`) over the reducer, a
// held store on a clock the test moves, and the real signing flow.
function harness(signer: Signer, submit = mockSubmit) {
  const retryPayment = vi.fn((runId: string, paymentId: string) =>
    api.runs.retryPayment(runId, paymentId),
  )
  const runApi: RunApi = {
    confirmPayment: (runId, paymentId, signature) =>
      api.runs.confirmPayment(runId, paymentId, signature),
    retryPayment,
  }
  const create = vi.spyOn(api.runs, "create")
  let clock = 0
  const held = createHeldStore(() => clock)
  let local: LocalRows = {}
  const dispatch = (action: LocalAction) =>
    (local = localReducer(local, action))
  const events = runEvents(held, dispatch)
  let time = 0
  const sign: RunContext["sign"] = (prepared, confirm, onStep, extra) =>
    signAndConfirm(prepared, {
      signer,
      submit,
      confirm,
      onStep,
      signal: extra?.signal,
      onSubmitted: extra?.onSubmitted,
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
    })
  const context = (created: RunCreated): RunContext => ({
    runId: created.run_id,
    sign,
    api: holdingRetries(runApi, held),
    events,
  })
  return {
    held,
    events,
    context,
    retryPayment,
    create,
    local: () => local,
    dispatch,
    advance: (ms: number) => (clock += ms),
    // What the hook's `signAgain` does.
    signAgain: (created: RunCreated, paymentId: string) =>
      signAgain(context(created), held, dispatch, paymentId),
  }
}

async function createRun() {
  const created = await api.runs.create({
    company_wallet: COMPANY_WALLET,
    payments: payees,
    idempotency_key: "d0000000-0000-4000-8000-000000000002",
  })
  return created
}

describe("a cancelled signature in a run", () => {
  it("is signed again from the same transaction, with no retry and no second run", async () => {
    scenarios.set("instant")
    const created = await createRun()
    const first = created.payments[0]
    const base = mockSigner(COMPANY_WALLET)
    let refuse = true
    const signed: string[] = []
    const signer: Signer = {
      address: base.address,
      signTransaction: async (bytes) => {
        if (refuse) throw refusal()
        signed.push(Buffer.from(bytes).toString("base64"))
        return base.signTransaction(bytes)
      },
    }
    const h = harness(signer)
    h.held.holdAll(created.payments)
    const createCalls = h.create.mock.calls.length

    await payOne(h.context(created), first)

    // Cancelled: not retryable, not sent, still held.
    let row = mergeRow(h.local()[first.payment_id], {
      status: "pending",
      failure: null,
    })
    expect(row.status).toBe("cancelled")
    expect(canSignAgain(row)).toBe(true)
    expect(canRetry(row)).toBe(false)
    expect(canRecheck(row)).toBe(false)
    expect(row.message).toBe("You cancelled the signature. Nothing was sent.")
    expect(h.held.lookup(first.payment_id).status).toBe("ready")
    // The service would refuse a retry of this payment: it neither failed nor expired.
    await expect(
      api.runs.retryPayment(created.run_id, first.payment_id),
    ).rejects.toMatchObject({ code: "payment_not_retryable" })

    // Sign again: the held transaction, as prepared.
    refuse = false
    await h.signAgain(created, first.payment_id)

    const run = await api.runs.get(created.run_id)
    row = mergeRow(
      h.local()[first.payment_id],
      run.payments.find((p) => p.payment_id === first.payment_id),
    )
    expect(row.status).toBe("confirmed")
    expect(signed).toEqual([first.transaction])
    expect(h.held.has(first.payment_id)).toBe(false)
    expect(h.retryPayment).not.toHaveBeenCalled()
    expect(h.create.mock.calls.length).toBe(createCalls)
    expect(
      db.payments.filter((p) => p.personId === bruno.id && p.runId !== null),
    ).toHaveLength(1)
  })

  it("stays held and signable when the signature is cancelled twice", async () => {
    const created = await createRun()
    const first = created.payments[0]
    const base = mockSigner(COMPANY_WALLET)
    const h = harness({
      address: base.address,
      signTransaction: async () => {
        throw refusal()
      },
    })
    h.held.holdAll(created.payments)

    await payOne(h.context(created), first)
    await payOne(h.context(created), first)

    expect(h.local()[first.payment_id].status).toBe("cancelled")
    expect(h.held.lookup(first.payment_id).status).toBe("ready")
  })

  it("is not re-signed after a failure that came once the transaction was submitted", async () => {
    scenarios.set("instant")
    const created = await createRun()
    const first = created.payments[0]
    // The transaction leaves and the connection drops before the answer.
    const h = harness(mockSigner(COMPANY_WALLET), async () => {
      throw new Error("socket closed")
    })
    h.held.holdAll(created.payments)

    await payOne(h.context(created), first)

    const row = mergeRow(h.local()[first.payment_id])
    expect(row.status).toBe("unknown")
    expect(canSignAgain(row)).toBe(false)
    expect(canRetry(row)).toBe(false)
    expect(h.held.has(first.payment_id)).toBe(false)
    expect(h.held.lookup(first.payment_id).status).toBe("gone")
  })

  it("is not re-signed when the network took it and confirming failed", async () => {
    const created = await createRun()
    const first = created.payments[0]
    const h = harness(mockSigner(COMPANY_WALLET))
    h.held.holdAll(created.payments)
    // Submitted, then the service goes down.
    scenarios.set("service-down")

    await payOne(h.context(created), first)

    const row = mergeRow(h.local()[first.payment_id])
    expect(row.status).toBe("waiting")
    expect(row.stalled).toBe(true)
    expect(canSignAgain(row)).toBe(false)
    expect(h.held.has(first.payment_id)).toBe(false)
  })

  it("is told apart from a refusal by the network, which stays a failure to retry", async () => {
    scenarios.set("tx-failed", "instant")
    const created = await createRun()
    const first = created.payments[0]
    const h = harness(mockSigner(COMPANY_WALLET))
    h.held.holdAll(created.payments)

    await payOne(h.context(created), first)

    const row = mergeRow(h.local()[first.payment_id])
    expect(row.status).toBe("failed")
    expect(canRetry(row)).toBe(true)
    expect(canSignAgain(row)).toBe(false)
    expect(h.held.has(first.payment_id)).toBe(false)
  })
})

describe("signing again past the life of a blockhash", () => {
  it("drops the held transaction and falls back to the normal retry path", async () => {
    scenarios.set("instant")
    const created = await createRun()
    const first = created.payments[0]
    const base = mockSigner(COMPANY_WALLET)
    const signTransaction = vi.fn(async () => {
      throw refusal()
    })
    const h = harness({ address: base.address, signTransaction })
    h.held.holdAll(created.payments)
    await payOne(h.context(created), first)
    expect(signTransaction).toHaveBeenCalledTimes(1)
    expect(h.local()[first.payment_id].status).toBe("cancelled")

    h.advance(heldMaxAgeMs)
    await h.signAgain(created, first.payment_id)

    // Nothing was signed or submitted again, and nothing was prepared.
    expect(signTransaction).toHaveBeenCalledTimes(1)
    expect(h.retryPayment).not.toHaveBeenCalled()
    expect(h.held.has(first.payment_id)).toBe(false)
    const row = mergeRow(h.local()[first.payment_id], {
      status: "pending",
      failure: null,
    })
    expect(row).toMatchObject({
      status: "failed",
      message: cancelledStaleMessage,
    })
    expect(canRetry(row)).toBe(true)
    expect(canSignAgain(row)).toBe(false)
  })

  it("still signs it again one millisecond before", async () => {
    scenarios.set("instant")
    const created = await createRun()
    const first = created.payments[0]
    let refuse = true
    const base = mockSigner(COMPANY_WALLET)
    const h = harness({
      address: base.address,
      signTransaction: async (bytes) => {
        if (refuse) throw refusal()
        return base.signTransaction(bytes)
      },
    })
    h.held.holdAll(created.payments)
    await payOne(h.context(created), first)
    refuse = false

    h.advance(heldMaxAgeMs - 1)
    await h.signAgain(created, first.payment_id)

    expect(h.local()[first.payment_id].status).toBe("confirmed")
  })

  it("leaves a transaction this page does not hold as it is", async () => {
    const created = await createRun()
    const base = mockSigner(COMPANY_WALLET)
    const signTransaction = vi.fn(base.signTransaction)
    const h = harness({ address: base.address, signTransaction })

    await h.signAgain(created, created.payments[0].payment_id)

    expect(signTransaction).not.toHaveBeenCalled()
    expect(h.local()).toEqual({})
  })
})

describe("a retry's transaction", () => {
  it("is held like the first ones, and only when it is for the payment asked about", async () => {
    scenarios.set("partial-failure", "instant")
    const created = await createRun()
    const h = harness(mockSigner(COMPANY_WALLET))
    const api2 = holdingRetries(
      {
        confirmPayment: async () => {
          throw new Error("unused")
        },
        retryPayment: async () => created.payments[1],
      },
      h.held,
    )

    await api2.retryPayment(created.run_id, created.payments[1].payment_id)
    expect(h.held.has(created.payments[1].payment_id)).toBe(true)

    // An answer for another payment is refused by the executor, and never held.
    await api2.retryPayment(created.run_id, created.payments[0].payment_id)
    expect(h.held.has(created.payments[0].payment_id)).toBe(false)
  })
})

describe("what each event does to a held transaction", () => {
  const held = (...ids: string[]) => {
    const store = createHeldStore(() => 0)
    for (const id of ids) {
      store.hold({
        request_id: "a".repeat(64),
        transaction: "AQID",
        transaction_version: 1,
        required_signers: ["wallet"],
        recent_blockhash: "blockhash",
        last_valid_block_height: 1,
        payment_id: id,
        person_id: id,
      })
    }
    return store
  }

  it("drops it once it was handed to the network, and once it was confirmed", () => {
    const store = held("a", "b", "c")
    const events = runEvents(store, () => {})
    events.signing("a")
    events.waiting("a")
    expect(store.has("a")).toBe(true)
    events.submitted("a", "5Sig")
    events.confirmed("b")
    expect(store.has("a")).toBe(false)
    expect(store.has("b")).toBe(false)
    expect(store.has("c")).toBe(true)
  })

  it("keeps it for a refused signature only, and tells the reducer which it was", () => {
    const store = held("a", "b")
    const actions: LocalAction[] = []
    const events = runEvents(store, (action) => actions.push(action))
    events.failed("a", refusal())
    events.failed("b", new Error("boom"))
    expect(store.has("a")).toBe(true)
    expect(store.has("b")).toBe(false)
    expect(
      actions.map((action) => "cancelled" in action && action.cancelled),
    ).toEqual([true, false])
  })

  it("runs what the hook adds after a confirmation and after a failure", () => {
    const after = { confirmed: vi.fn(), failed: vi.fn() }
    const events = runEvents(held("a"), () => {}, after)
    events.confirmed("a")
    events.failed("a", new Error("x"))
    expect(after.confirmed).toHaveBeenCalledTimes(1)
    expect(after.failed).toHaveBeenCalledTimes(1)
  })
})

describe("what counts as a cancelled signature", () => {
  it("is a refusal by the person, never a failure that came after the submit", () => {
    expect(keepsHeld(refusal())).toBe(true)
    expect(keepsHeld(Object.assign(new Error(), { code: 4001 }))).toBe(true)
    expect(keepsHeld(new Error("boom"))).toBe(false)
    expect(isSignatureRejection(refusal())).toBe(true)
  })
})
