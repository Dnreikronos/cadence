import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createApiClient } from "@/lib/api/client"
import { MOCK_ORIGIN } from "@/lib/api/config"
import type { RunCreated } from "@/lib/api/schemas"
import { signatureSchema } from "@/lib/api/schemas"
import { signAndConfirm } from "@/lib/api/sign"
import { COMPANY_WALLET, db, resetDb, seedPeople } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { mockSigner, mockSubmit } from "@/lib/api/mocks/signer"
import {
  paySequence,
  recheckOne,
  retryOne,
  type RunApi,
  type RunContext,
  type RunEvents,
} from "./executor"
import { describeFailure } from "./messages"
import {
  canRecheck,
  canRetry,
  localReducer,
  mergeRow,
  type LocalRows,
} from "./progress"

// The executor against the real `signAndConfirm` and the mock service's handlers (the
// same ones the browser runs), so the glue between them is exercised and not only the
// executor's own fakes: the steps `signAndConfirm` reports, the phase rule built on
// them, and the answers the mock gives.

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
const runApi: RunApi = {
  confirmPayment: (runId, paymentId, signature) =>
    api.runs.confirmPayment(runId, paymentId, signature),
  retryPayment: (runId, paymentId) => api.runs.retryPayment(runId, paymentId),
}

const [bruno, , diego, northwind] = seedPeople
const payees = [
  { person_id: bruno.id, amount: "4200000000" },
  { person_id: diego.id, amount: "6300000000" },
  { person_id: northwind.id, amount: "9500000000" },
]

async function createRun(): Promise<RunCreated> {
  return api.runs.create({
    company_wallet: COMPANY_WALLET,
    payments: payees,
    idempotency_key: "d0000000-0000-4000-8000-000000000001",
  })
}

// The real `signAndConfirm`, with a clock that only moves when it sleeps, so waiting out
// a minute of "not finalized" takes no time.
function realSign(submit: (signed: Uint8Array) => Promise<string>) {
  let time = 0
  const sign: RunContext["sign"] = (prepared, confirm, onStep, extra) =>
    signAndConfirm(prepared, {
      signer: mockSigner(COMPANY_WALLET),
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
  return sign
}

// What the signer hook does: every event goes through the real reducer.
function recorder() {
  let local: LocalRows = {}
  const events: RunEvents = {
    signing: (id) => (local = localReducer(local, { type: "signing", id })),
    waiting: (id) => (local = localReducer(local, { type: "waiting", id })),
    submitted: (id, signature) =>
      (local = localReducer(local, { type: "submitted", id, signature })),
    confirmed: (id) => (local = localReducer(local, { type: "confirmed", id })),
    failed: (id, error) =>
      (local = localReducer(local, {
        type: "failed",
        id,
        ...describeFailure(error),
      })),
  }
  return { events, local: () => local }
}

async function rowsOf(created: RunCreated, local: LocalRows) {
  const run = await api.runs.get(created.run_id)
  return created.payments.map((payment) => {
    const server = run.payments.find((p) => p.payment_id === payment.payment_id)
    return mergeRow(local[payment.payment_id], server)
  })
}

describe("a run through the real signing flow and the mock service", () => {
  it("confirms every payment, in order, and moves the company's money", async () => {
    scenarios.set("instant")
    const created = await createRun()
    const before = db.company.available
    const { events, local } = recorder()

    await paySequence(
      {
        runId: created.run_id,
        sign: realSign(mockSubmit),
        api: runApi,
        events,
      },
      created.payments,
    )

    const rows = await rowsOf(created, local())
    expect(rows.map((row) => row.status)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
    ])
    expect(before - db.company.available).toBe(20_000_000_000n)
  })

  it("keeps a payment whose submit threw after the broadcast as sent, never retryable", async () => {
    scenarios.set("instant")
    const created = await createRun()
    const { events, local } = recorder()
    let submits = 0
    const submit = async () => {
      submits += 1
      // The first transaction leaves and the connection drops before the answer.
      if (submits === 1) throw new Error("socket closed")
      return mockSubmit()
    }

    await paySequence(
      { runId: created.run_id, sign: realSign(submit), api: runApi, events },
      created.payments,
    )

    const rows = await rowsOf(created, local())
    expect(rows.map((row) => row.status)).toEqual([
      "unknown",
      "confirmed",
      "confirmed",
    ])
    // Nothing to ask about and nothing to retry: only the admin's own check is left.
    expect(canRetry(rows[0])).toBe(false)
    expect(canRecheck(rows[0])).toBe(false)
    expect(rows[0].message).toMatch(/company payments and balance/)
  })

  it("keeps a payment whose confirm never answered as sent, then settles it with the same signature", async () => {
    const created = await createRun()
    const { events, local } = recorder()
    // The service goes down after the transaction was sent: confirm cannot be asked.
    scenarios.set("service-down")

    await paySequence(
      {
        runId: created.run_id,
        sign: realSign(mockSubmit),
        api: runApi,
        events,
      },
      created.payments.slice(0, 1),
    )

    // The service is down, so only what this browser saw can be read.
    let row = mergeRow(local()[created.payments[0].payment_id])
    expect(row.status).toBe("waiting")
    expect(canRecheck(row)).toBe(true)
    expect(canRetry(row)).toBe(false)
    const signature = row.signature!

    // Back up: asking again about the very signature that was sent settles it.
    scenarios.set("instant")
    await recheckOne(
      {
        runId: created.run_id,
        sign: realSign(mockSubmit),
        api: runApi,
        events,
      },
      created.payments[0].payment_id,
      signature,
    )
    ;[row] = await rowsOf(created, local())
    expect(row.status).toBe("confirmed")
  })

  it("lets one payment fail on the network, retries it with a fresh transaction, and pays the person once", async () => {
    scenarios.set("partial-failure", "instant")
    const created = await createRun()
    const { events, local } = recorder()
    const context = {
      runId: created.run_id,
      sign: realSign(mockSubmit),
      api: runApi,
      events,
    }

    await paySequence(context, created.payments)
    let rows = await rowsOf(created, local())
    // Payment 2 was rejected by the network; payment 3 never landed and is `expired`.
    expect(rows.map((row) => row.status)).toEqual([
      "confirmed",
      "failed",
      "expired",
    ])
    expect(rows.slice(1).every(canRetry)).toBe(true)

    await retryOne(context, created.payments[1].payment_id)
    await retryOne(context, created.payments[2].payment_id)
    rows = await rowsOf(created, local())
    expect(rows.map((row) => row.status)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
    ])
    // Each person was paid exactly once.
    const paid = db.payments.filter((p) => p.runId === created.run_id)
    expect(paid.map((p) => p.personId).sort()).toEqual(
      payees.map((p) => p.person_id).sort(),
    )
  })

  it("refuses to retry a payment that already confirmed", async () => {
    scenarios.set("instant")
    const created = await createRun()
    const { events, local } = recorder()
    const context = {
      runId: created.run_id,
      sign: realSign(mockSubmit),
      api: runApi,
      events,
    }
    await paySequence(context, created.payments.slice(0, 1))
    let sent = 0
    await retryOne(
      {
        ...context,
        sign: realSign(async () => {
          sent += 1
          return mockSubmit()
        }),
      },
      created.payments[0].payment_id,
    )
    // The service said no, so nothing was signed or sent and nobody is paid twice.
    expect(sent).toBe(0)
    expect(
      db.payments.filter((p) => p.personId === bruno.id && p.runId !== null),
    ).toHaveLength(1)
    const [row] = await rowsOf(created, local())
    expect(row.status).toBe("confirmed")
  })
})

describe("the mock wallet's signatures", () => {
  it("stay valid and distinct however many payments a session makes", async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const signature = await mockSubmit()
      expect(signatureSchema.safeParse(signature).success).toBe(true)
      seen.add(signature)
    }
    expect(seen.size).toBe(300)
  })
})
