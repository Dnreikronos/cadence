import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createApiClient } from "@/lib/api/client"
import { MOCK_ORIGIN } from "@/lib/api/config"
import type { RunCreated } from "@/lib/api/schemas"
import { signAndConfirm } from "@/lib/api/sign"
import { COMPANY_WALLET, db, resetDb, seedPeople } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { mockSigner, mockSubmit } from "@/lib/api/mocks/signer"
import type { SubmissionStorage } from "@/lib/submissions"
import {
  attemptCreated,
  attemptFor,
  beginAttempt,
  recordEvidence,
  runEvidence,
  savedAttempt,
  unsettledPeople,
} from "./evidence"
import {
  paySequence,
  type RunApi,
  type RunContext,
  type RunEvents,
} from "./executor"
import { describeFailure } from "./messages"
import { localReducer, mergeRow, type LocalRows } from "./progress"
import { buildRunRequest, fingerprintOf, type PayrollPerson } from "./plan"
import { hydrateLocal, recoverOne } from "./recover"

// A reload in the middle of a run, against the mock service's handlers: what is kept, what
// the next page finds out, and that nobody is paid twice.

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

const viewer = { company: "Solaris", email: "admin@solaris.example" }
const [bruno, , diego, northwind] = seedPeople
const roster = [
  [bruno, "4200000000"],
  [diego, "6300000000"],
  [northwind, "9500000000"],
].map(
  ([person, amount]) =>
    ({
      id: (person as typeof bruno).id,
      name: (person as typeof bruno).name,
      email: "x@example.test",
      kind: "employee",
      activation: "active",
      amount: amount as string,
    }) satisfies PayrollPerson,
)
const fingerprint = fingerprintOf(COMPANY_WALLET, roster)

function fakeStorage(): SubmissionStorage {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}

// The real `signAndConfirm`, with a clock that only moves when it sleeps.
function realSign(options: { stopAfterSubmit?: AbortController } = {}) {
  let time = 0
  const sign: RunContext["sign"] = (prepared, confirm, onStep, extra) =>
    signAndConfirm(prepared, {
      signer: mockSigner(COMPANY_WALLET),
      submit: mockSubmit,
      confirm,
      onStep,
      signal: extra?.signal,
      onSubmitted: (signature) => {
        extra?.onSubmitted?.(signature)
        // The page is closed right after the network took the transaction.
        options.stopAfterSubmit?.abort()
      },
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
    })
  return sign
}

function screenEvents() {
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
  return {
    events,
    local: () => local,
    set: (rows: LocalRows) => (local = rows),
  }
}

async function startRun(
  storage: SubmissionStorage,
  key: string,
): Promise<RunCreated> {
  const evidence = runEvidence(viewer, storage)
  const { key: attempt } = attemptFor(
    evidence,
    null,
    fingerprint,
    () => key,
    1_000,
  )
  beginAttempt(evidence, { idempotency_key: attempt.key, fingerprint }, 1_000)
  const created = await api.runs.create(
    buildRunRequest(COMPANY_WALLET, roster, attempt.key),
  )
  attemptCreated(evidence, fingerprint, created.run_id)
  return created
}

describe("replaying the create after a reload", () => {
  it("sends the saved key for the same list, and the service answers with the run it already made", async () => {
    const storage = fakeStorage()
    const first = await startRun(
      storage,
      "d0000000-0000-4000-8000-000000000001",
    )

    // A reload: nothing in memory, a new random key on offer, the saved one wins.
    const evidence = runEvidence(viewer, storage)
    const { key, saved } = attemptFor(
      evidence,
      null,
      fingerprint,
      () => "d0000000-0000-4000-8000-0000000000ff",
      2_000,
    )
    expect(key.key).toBe("d0000000-0000-4000-8000-000000000001")
    expect(saved?.run_id).toBe(first.run_id)

    const again = await api.runs.create(
      buildRunRequest(COMPANY_WALLET, [...roster].reverse(), key.key),
    )
    expect(again.run_id).toBe(first.run_id)
    expect(again.payments.map((p) => p.payment_id)).toEqual(
      first.payments.map((p) => p.payment_id),
    )
    expect(db.runs.size).toBe(1)
  })

  it("makes a new key for a changed list, which is a different run", async () => {
    const storage = fakeStorage()
    await startRun(storage, "d0000000-0000-4000-8000-000000000001")
    const evidence = runEvidence(viewer, storage)
    const { key } = attemptFor(
      evidence,
      null,
      fingerprintOf(COMPANY_WALLET, roster.slice(1)),
      () => "d0000000-0000-4000-8000-0000000000ff",
      2_000,
    )
    expect(key.key).toBe("d0000000-0000-4000-8000-0000000000ff")
  })

  it("does not find another viewer's attempt", async () => {
    const storage = fakeStorage()
    await startRun(storage, "d0000000-0000-4000-8000-000000000001")
    const other = runEvidence(
      { company: "Solaris", email: "someone.else@solaris.example" },
      storage,
    )
    expect(savedAttempt(other, fingerprint, 2_000)).toBeNull()
  })
})

describe("a run left while its first payment was being confirmed", () => {
  // Page one: pays the first payment, and is closed once the network has it.
  async function pageOne(storage: SubmissionStorage) {
    const created = await startRun(
      storage,
      "d0000000-0000-4000-8000-000000000001",
    )
    const stop = new AbortController()
    const evidence = runEvidence(viewer, storage)
    const { events } = screenEvents()
    await paySequence(
      {
        runId: created.run_id,
        sign: realSign({ stopAfterSubmit: stop }),
        api: runApi,
        events: recordEvidence(events, evidence, created.run_id, () => 2_000),
        signal: stop.signal,
      },
      created.payments,
    )
    return created
  }

  it("leaves a record of the one that was sent, and nothing for the two that were not", async () => {
    scenarios.set("instant")
    const storage = fakeStorage()
    const created = await pageOne(storage)

    const kept = runEvidence(viewer, storage).payments.read()
    expect(kept).toEqual([
      expect.objectContaining({
        payment_id: created.payments[0].payment_id,
        person_id: bruno.id,
        run_id: created.run_id,
        request_id: created.payments[0].request_id,
        last_valid_block_height: created.payments[0].last_valid_block_height,
        at: 2_000,
      }),
    ])
    expect(kept[0].signature).toMatch(/\S{43,}/)
    // Bruno may have been paid, so a new run must not include him.
    expect([...unsettledPeople(kept)]).toEqual([bruno.id])
    // The other two were never sent: not paid, and nothing says they were.
    expect(db.company.available).toBe(84_000_000_000n)
  })

  it("confirms it with the saved signature on the next page, pays nobody twice, and clears the attempt", async () => {
    scenarios.set("instant")
    const storage = fakeStorage()
    const created = await pageOne(storage)

    // Page two, after the reload.
    const evidence = runEvidence(viewer, storage)
    const { events, local, set } = screenEvents()
    set(hydrateLocal(evidence.payments.read()))
    expect(local()[created.payments[0].payment_id].status).toBe("waiting")

    let signed = 0
    const sign: RunContext["sign"] = async (...args) => {
      signed += 1
      return realSign()(...args)
    }
    for (const record of evidence.payments.read()) {
      await recoverOne(
        {
          runId: record.run_id,
          sign,
          api: runApi,
          events: recordEvidence(events, evidence, record.run_id),
        },
        record,
      )
    }
    expect(signed).toBe(0)
    expect(local()[created.payments[0].payment_id].status).toBe("confirmed")
    // One payment landed, once.
    expect(db.company.available).toBe(84_000_000_000n - 4_200_000_000n)
    expect(evidence.payments.read()).toEqual([])
    expect(savedAttempt(evidence, fingerprint, 3_000)).toBeNull()

    // The service agrees, and the two never sent are plainly pending, not paid.
    const run = await api.runs.get(created.run_id)
    const rows = created.payments.map((payment) =>
      mergeRow(
        local()[payment.payment_id],
        run.payments.find((p) => p.payment_id === payment.payment_id),
      ),
    )
    expect(rows.map((row) => row.status)).toEqual([
      "confirmed",
      "pending",
      "pending",
    ])
  })

  it("keeps it unsettled and asks again later when the service cannot be reached", async () => {
    scenarios.set("instant")
    const storage = fakeStorage()
    await pageOne(storage)

    scenarios.set("service-down")
    const evidence = runEvidence(viewer, storage)
    const { events, local, set } = screenEvents()
    set(hydrateLocal(evidence.payments.read()))
    const [record] = evidence.payments.read()
    let time = record.at
    await recoverOne(
      {
        runId: record.run_id,
        sign: realSign(),
        api: runApi,
        events: recordEvidence(events, evidence, record.run_id),
      },
      record,
      // A clock that moves only when the check waits: its 90 seconds run instantly.
      {
        sleep: async (ms) => void (time += ms),
        pollMs: 3_000,
        now: () => time,
      },
    )
    expect(local()[record.payment_id]).toMatchObject({
      status: "waiting",
      stalled: true,
      signature: record.signature,
    })
    expect(evidence.payments.read()).toHaveLength(1)
    expect([...unsettledPeople(evidence.payments.read())]).toEqual([bruno.id])

    // The service is back: asking again settles it.
    scenarios.set("instant")
    await recoverOne(
      {
        runId: record.run_id,
        sign: realSign(),
        api: runApi,
        events: recordEvidence(events, evidence, record.run_id),
      },
      record,
    )
    expect(local()[record.payment_id].status).toBe("confirmed")
    expect(evidence.payments.read()).toEqual([])
  })

  it("settles a payment the network refused as failed, so the person is free again", async () => {
    scenarios.set("instant")
    const storage = fakeStorage()
    const created = await pageOne(storage)

    scenarios.set("tx-failed")
    const evidence = runEvidence(viewer, storage)
    const { events, local, set } = screenEvents()
    set(hydrateLocal(evidence.payments.read()))
    const [record] = evidence.payments.read()
    await recoverOne(
      {
        runId: record.run_id,
        sign: realSign(),
        api: runApi,
        events: recordEvidence(events, evidence, record.run_id),
      },
      record,
    )
    expect(local()[record.payment_id].status).toBe("failed")
    expect(evidence.payments.read()).toEqual([])
    expect(unsettledPeople(evidence.payments.read()).size).toBe(0)
    expect(created.payments[0].payment_id).toBe(record.payment_id)
  })
})
