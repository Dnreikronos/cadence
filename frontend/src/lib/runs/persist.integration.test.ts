import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createApiClient } from "@/lib/api/client"
import { MOCK_ORIGIN } from "@/lib/api/config"
import type { Run } from "@/lib/api/schemas"
import { signAndConfirm } from "@/lib/api/sign"
import { mockBlockHeight, mockTokenAccount } from "@/lib/api/mocks/chain"
import { COMPANY_WALLET, db, resetDb, seedPeople } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { mockSigner, mockSubmit } from "@/lib/api/mocks/signer"
import type { SubmissionStorage } from "@/lib/submissions"
import {
  recordEvidence,
  runBlocker,
  runEvidence,
  unsettledPeople,
} from "./evidence"
import {
  paymentKey,
  paySequence,
  signablesOf,
  type RunApi,
  type RunContext,
  type RunEvents,
} from "./executor"
import { describeFailure } from "./messages"
import { localReducer, mergeRow, type LocalRows } from "./progress"
import { buildRunRequest, type PayrollPerson } from "./plan"
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
  confirm: (runId, item) => api.runs.confirm(runId, { payments: [item] }),
  retry: (runId, request) => api.runs.retry(runId, request),
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
      tokenAccount: mockTokenAccount((person as typeof bruno).id),
    }) satisfies PayrollPerson,
)
// Position i pays roster[i].
const personOf = (position: number) => roster[position].id

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

async function startRun(): Promise<Run> {
  const request = buildRunRequest(
    COMPANY_WALLET,
    mockTokenAccount(COMPANY_WALLET),
    "AAAAAAAAAAAAAAAAAAAAAA==",
    roster,
  )
  return api.runs.create({
    ...request,
    wallet_signature: "5SigMockSignature1111111111111111111111111111",
  })
}

describe("a run whose create answer was lost", () => {
  it("keeps nothing and blocks nobody: its transactions were never signed, so they cannot land", async () => {
    const storage = fakeStorage()
    const lost = await startRun()
    const evidence = runEvidence(viewer, storage)
    expect(evidence.payments.read()).toEqual([])
    expect(runBlocker(evidence, roster)).toBeNull()

    // A new run for the same people is a second run, and only that one pays anyone.
    scenarios.set("instant")
    const again = await startRun()
    expect(again.run_id).not.toBe(lost.run_id)
    await paySequence(
      {
        runId: again.run_id,
        sign: realSign(),
        api: runApi,
        events: screenEvents().events,
      },
      signablesOf(again),
    )
    expect(db.payments.filter((p) => p.runId === lost.run_id)).toEqual([])
    expect(db.payments.filter((p) => p.runId === again.run_id)).toHaveLength(3)
  })
})

describe("a run left while its first payment was being confirmed", () => {
  // Page one: pays the first payment, and is closed once the network has it.
  async function pageOne(storage: SubmissionStorage) {
    const created = await startRun()
    const stop = new AbortController()
    const evidence = runEvidence(viewer, storage)
    const { events } = screenEvents()
    await paySequence(
      {
        runId: created.run_id,
        sign: realSign({ stopAfterSubmit: stop }),
        api: runApi,
        events: recordEvidence(
          events,
          evidence,
          created.run_id,
          personOf,
          () => 2_000,
        ),
        signal: stop.signal,
      },
      signablesOf(created),
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
        position: 0,
        attempt: 0,
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

  it("confirms it with the saved signature on the next page, pays nobody twice, and clears the record", async () => {
    scenarios.set("instant")
    const storage = fakeStorage()
    const created = await pageOne(storage)

    // Page two, after the reload.
    const evidence = runEvidence(viewer, storage)
    const { events, local, set } = screenEvents()
    set(hydrateLocal(evidence.payments.read()))
    const first = paymentKey(created.run_id, 0)
    expect(local()[first].status).toBe("waiting")

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
          events: recordEvidence(events, evidence, record.run_id, personOf),
        },
        record,
      )
    }
    expect(signed).toBe(0)
    expect(local()[first].status).toBe("confirmed")
    // One payment landed, once.
    expect(db.company.available).toBe(84_000_000_000n - 4_200_000_000n)
    expect(evidence.payments.read()).toEqual([])

    // The service agrees, and the two never sent read as not sent: not paid.
    const run = await api.runs.get(created.run_id)
    const rows = run.payments.map((payment) =>
      mergeRow(local()[paymentKey(created.run_id, payment.position)], payment),
    )
    expect(rows.map((row) => row.status)).toEqual([
      "confirmed",
      "not-sent",
      "not-sent",
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
    let time = Date.now()
    await recoverOne(
      {
        runId: record.run_id,
        sign: realSign(),
        api: runApi,
        events: recordEvidence(events, evidence, record.run_id, personOf),
      },
      record,
      // The mock chain on a clock that moves only when the check waits: the minute of
      // the blockhash runs instantly.
      {
        sleep: async (ms) => void (time += ms),
        pollMs: 3_000,
        blockHeight: async () => mockBlockHeight(time),
      },
    )
    expect(local()[paymentKey(record.run_id, record.position)]).toMatchObject({
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
        events: recordEvidence(events, evidence, record.run_id, personOf),
      },
      record,
    )
    expect(local()[paymentKey(record.run_id, record.position)].status).toBe(
      "confirmed",
    )
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
        events: recordEvidence(events, evidence, record.run_id, personOf),
      },
      record,
    )
    expect(local()[paymentKey(record.run_id, record.position)].status).toBe(
      "failed",
    )
    expect(evidence.payments.read()).toEqual([])
    expect(unsettledPeople(evidence.payments.read()).size).toBe(0)
    expect(record).toMatchObject({ run_id: created.run_id, position: 0 })
  })
})
