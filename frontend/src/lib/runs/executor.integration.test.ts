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
import { ApiError } from "@/lib/api/errors"
import { MOCK_ORIGIN } from "@/lib/api/config"
import type { Run } from "@/lib/api/schemas"
import { signatureSchema } from "@/lib/api/schemas"
import { signAndConfirm } from "@/lib/api/sign"
import { mockFinality, mockTokenAccount } from "@/lib/api/mocks/chain"
import { COMPANY_WALLET, db, resetDb, seedPeople } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { mockSigner, mockSubmit } from "@/lib/api/mocks/signer"
import {
  approvedPayees,
  checkedSign,
  paymentKey,
  paySequence,
  recheckOne,
  retryRun,
  signablesOf,
  type RunApi,
  type RunContext,
  type RunEvents,
} from "./executor"
import {
  describeFailure,
  refusedTransactionMessage,
  runMessage,
} from "./messages"
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
const runApi: RunApi = {
  confirm: (runId, item) => api.runs.confirm(runId, { payments: [item] }),
  retry: (runId, request) => api.runs.retry(runId, request),
}

const [bruno, , diego, northwind] = seedPeople
const payees = [
  { id: bruno.id, amount: "4200000000" },
  { id: diego.id, amount: "6300000000" },
  { id: northwind.id, amount: "9500000000" },
]
const AES_KEY = "AAAAAAAAAAAAAAAAAAAAAA=="

async function createRun(): Promise<Run> {
  return api.runs.create({
    company_wallet: COMPANY_WALLET,
    sender: mockTokenAccount(COMPANY_WALLET),
    aes_key: AES_KEY,
    wallet_signature: "5SigMockSignature1111111111111111111111111111",
    payments: payees.map((p) => ({
      recipient: mockTokenAccount(p.id),
      amount: p.amount,
    })),
  })
}

// The accounts the run below pays, by position, as `approvedPayees` keeps them.
const approved =
  (
    entries: [number, string][] = payees.map((p, i) => [
      i,
      mockTokenAccount(p.id),
    ]),
  ) =>
  async () => ({
    wallet: COMPANY_WALLET,
    sender: mockTokenAccount(COMPANY_WALLET),
    payees: approvedPayees(entries),
  })

// The real `signAndConfirm` with the run's pre-sign check (`checkedSign`), and a clock
// that only moves when it sleeps, so waiting out a minute of "not finalized" takes no
// time.
function realSign(
  submit: (signed: Uint8Array) => Promise<string>,
  allowlist = approved(),
): RunContext["sign"] {
  let time = 0
  const sign: Parameters<typeof checkedSign>[0] = (
    prepared,
    confirm,
    onStep,
    extra,
  ) =>
    signAndConfirm(prepared, {
      signer: mockSigner(COMPANY_WALLET),
      submit,
      finality: mockFinality,
      confirm,
      onStep,
      check: extra.check,
      signal: extra.signal,
      onSubmitted: extra.onSubmitted,
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
    })
  return checkedSign(sign, allowlist)
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

// Rows as a page that holds no transaction any more reads them.
async function rowsOf(created: Run, local: LocalRows) {
  const run = await api.runs.get(created.run_id)
  return run.payments.map((payment) =>
    mergeRow(local[paymentKey(created.run_id, payment.position)], payment),
  )
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
      signablesOf(created),
    )

    const rows = await rowsOf(created, local())
    expect(rows.map((row) => row.status)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
    ])
    expect(before - db.company.available).toBe(20_000_000_000n)
    expect((await api.runs.get(created.run_id)).status).toBe("completed")
  })

  it("keeps a payment whose submit threw after the broadcast as sent, never retryable, and sends nothing after it", async () => {
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
      signablesOf(created),
    )

    const rows = await rowsOf(created, local())
    expect(rows.map((row) => row.status)).toEqual([
      "unknown",
      "not-sent",
      "not-sent",
    ])
    expect(submits).toBe(1)
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
      signablesOf(created).slice(0, 1),
    )

    // The service is down, so only what this browser saw can be read.
    let row = mergeRow(local()[paymentKey(created.run_id, 0)])
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
      signablesOf(created)[0],
      signature,
    )
    ;[row] = await rowsOf(created, local())
    expect(row.status).toBe("confirmed")
  })

  it("stops at a payment the network rejects, and a retry once the rest expired pays that person once", async () => {
    scenarios.set("partial-failure", "instant")
    const created = await createRun()
    const { events, local } = recorder()
    const context = {
      runId: created.run_id,
      sign: realSign(mockSubmit),
      api: runApi,
      events,
    }

    await paySequence(context, signablesOf(created))
    let rows = await rowsOf(created, local())
    // The second was rejected by the network; the third was never signed.
    expect(rows.map((row) => row.status)).toEqual([
      "confirmed",
      "failed",
      "not-sent",
    ])
    expect(canRetry(rows[1])).toBe(true)
    expect(canRetry(rows[2])).toBe(false)

    const request = {
      aes_key: AES_KEY,
      payments: [{ position: 1, amount: payees[1].amount }],
    }
    // While the third can still land, the service refuses: the row says to wait.
    const run = await api.runs.get(created.run_id)
    expect(await retryRun(context, run, request)).toBeNull()
    rows = await rowsOf(created, local())
    expect(rows[1]).toMatchObject({
      status: "failed",
      message: runMessage(new ApiError(409, "outstanding_payments")),
    })

    // A minute later it has expired; the retry rebuilds only the rejected one.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000)
    const rebuilt = await retryRun(context, run, request)
    expect(rebuilt?.map((p) => [p.position, p.attempt])).toEqual([[1, 1]])
    await paySequence(context, rebuilt ?? [])
    rows = await rowsOf(created, local())
    expect(rows.map((row) => row.status)).toEqual([
      "confirmed",
      "confirmed",
      "not-sent",
    ])
    // Each person paid was paid exactly once, and the third not at all.
    const paid = db.payments.filter((p) => p.runId === created.run_id)
    expect(paid.map((p) => p.personId).sort()).toEqual(
      [bruno.id, diego.id].sort(),
    )
  })

  it("never rebuilds a payment that already confirmed", async () => {
    scenarios.set("instant")
    const created = await createRun()
    const { events, local } = recorder()
    const context = {
      runId: created.run_id,
      sign: realSign(mockSubmit),
      api: runApi,
      events,
    }
    await paySequence(context, signablesOf(created))
    const rebuilt = await retryRun(
      context,
      await api.runs.get(created.run_id),
      { aes_key: AES_KEY, payments: [{ position: 0, amount: "4200000000" }] },
    )
    // The service skipped it: nothing to sign, nothing reported, and nobody is paid
    // twice.
    expect(rebuilt).toEqual([])
    expect(local()[paymentKey(created.run_id, 0)].status).toBe("confirmed")
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

describe("a run's payments against the accounts the admin approved", () => {
  it("signs and confirms a run that pays exactly the approved accounts", async () => {
    scenarios.set("instant")
    const created = await createRun()
    const { events, local } = recorder()

    await paySequence(
      {
        runId: created.run_id,
        sign: realSign(mockSubmit),
        api: runApi,
        events,
      },
      signablesOf(created),
    )

    const rows = await rowsOf(created, local())
    expect(rows.map((row) => row.status)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
    ])
  })

  it("signs nothing when the service prepared a payment to another account", async () => {
    scenarios.set("instant", "foreign-destination")
    const created = await createRun()
    const before = db.company.available
    const { events, local } = recorder()
    const submit = vi.fn(mockSubmit)

    await paySequence(
      {
        runId: created.run_id,
        sign: realSign(submit),
        api: runApi,
        events,
      },
      signablesOf(created),
    )

    expect(submit).not.toHaveBeenCalled()
    expect(db.company.available).toBe(before)
    expect(local()[paymentKey(created.run_id, 0)]).toMatchObject({
      status: "failed",
      message: refusedTransactionMessage,
    })
    // The run stops at the first refusal: the others are never signed.
    expect(local()[paymentKey(created.run_id, 1)]).toBeUndefined()
  })

  it("signs nothing for an account the admin did not approve, even if the transaction pays it", async () => {
    scenarios.set("instant")
    const created = await createRun()
    const { events, local } = recorder()
    const submit = vi.fn(mockSubmit)
    const [first, ...rest] = payees.map((p) => mockTokenAccount(p.id))
    // Approved for the two later positions only.

    await paySequence(
      {
        runId: created.run_id,
        sign: realSign(
          submit,
          approved(rest.map((account, i) => [i + 1, account])),
        ),
        api: runApi,
        events,
      },
      signablesOf(created),
    )

    expect(created.payments[0].destination).toBe(first)
    expect(submit).not.toHaveBeenCalled()
    expect(local()[paymentKey(created.run_id, 0)]).toMatchObject({
      status: "failed",
      message: refusedTransactionMessage,
    })
  })

  it("signs nothing when a payment goes to an approved account, but another position's", async () => {
    scenarios.set("instant")
    const created = await createRun()
    const { events, local } = recorder()
    const submit = vi.fn(mockSubmit)
    const [first, second, third] = payees.map((p) => mockTokenAccount(p.id))

    await paySequence(
      {
        runId: created.run_id,
        // The admin approved the first two people the other way round.
        sign: realSign(
          submit,
          approved([
            [0, second],
            [1, first],
            [2, third],
          ]),
        ),
        api: runApi,
        events,
      },
      signablesOf(created),
    )

    expect(submit).not.toHaveBeenCalled()
    expect(local()[paymentKey(created.run_id, 0)]).toMatchObject({
      status: "failed",
      message: refusedTransactionMessage,
    })
  })

  it("approves nothing when one account is approved for two positions", () => {
    const [first, second] = payees.map((p) => mockTokenAccount(p.id))
    expect(
      approvedPayees([
        [0, first],
        [1, second],
      ]).size,
    ).toBe(2)
    expect(
      approvedPayees([
        [0, first],
        [1, first],
      ]).size,
    ).toBe(0)
    // A later approval of a position replaces the earlier one.
    expect(
      approvedPayees([
        [0, first],
        [0, second],
      ]).get(0),
    ).toBe(second)
  })

  it("keeps a payment the service confirmed and the network never showed as sent, to ask about again", async () => {
    scenarios.set("instant", "chain-unconfirmed")
    const created = await createRun()
    const { events, local } = recorder()

    await paySequence(
      {
        runId: created.run_id,
        sign: realSign(mockSubmit),
        api: runApi,
        events,
      },
      signablesOf(created),
    )

    const row = mergeRow(local()[paymentKey(created.run_id, 0)])
    expect(row.status).toBe("waiting")
    expect(canRecheck(row)).toBe(true)
    expect(canRetry(row)).toBe(false)
    // Nothing after it was signed.
    expect(local()[paymentKey(created.run_id, 1)]).toBeUndefined()
  })
})
