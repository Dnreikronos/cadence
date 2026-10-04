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
import {
  payOne,
  type RunApi,
  type RunContext,
  type RunEvents,
} from "./executor"
import { createHeldStore, keepsHeld } from "./held"
import { describeFailure } from "./messages"
import {
  canRecheck,
  canRetry,
  canSignAgain,
  localReducer,
  mergeRow,
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

// Mirrors the hook: a held store beside the reducer, and the same rules for what is
// kept and what is dropped.
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
  const held = createHeldStore()
  let local: LocalRows = {}
  const events: RunEvents = {
    signing: (id) => (local = localReducer(local, { type: "signing", id })),
    waiting: (id) => (local = localReducer(local, { type: "waiting", id })),
    submitted: (id, signature) => {
      held.drop(id)
      local = localReducer(local, { type: "submitted", id, signature })
    },
    confirmed: (id) => {
      held.drop(id)
      local = localReducer(local, { type: "confirmed", id })
    },
    failed: (id, error) => {
      const cancelled = keepsHeld(error)
      if (!cancelled) held.drop(id)
      local = localReducer(local, {
        type: "failed",
        id,
        cancelled,
        ...describeFailure(error),
      })
    },
  }
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
    api: runApi,
    events,
  })
  return { held, events, context, retryPayment, create, local: () => local }
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
    const found = h.held.lookup(first.payment_id)
    if (found.status !== "ready") throw new Error("expected it to be held")
    await payOne(h.context(created), found.prepared)

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

describe("what counts as a cancelled signature", () => {
  it("is a refusal by the person, never a failure that came after the submit", () => {
    expect(keepsHeld(refusal())).toBe(true)
    expect(keepsHeld(Object.assign(new Error(), { code: 4001 }))).toBe(true)
    expect(keepsHeld(new Error("boom"))).toBe(false)
    expect(isSignatureRejection(refusal())).toBe(true)
  })
})
