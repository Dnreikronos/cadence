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
import type { Run } from "@/lib/api/schemas"
import { signAndConfirm, type Signer } from "@/lib/api/sign"
import { mockTokenAccount } from "@/lib/api/mocks/chain"
import { COMPANY_WALLET, db, resetDb, seedPeople } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { mockSigner, mockSubmit } from "@/lib/api/mocks/signer"
import {
  paymentKey,
  signablesOf,
  type RunApi,
  type RunContext,
  type Signable,
} from "./executor"
import { createHeldStore, heldMarginBlocks, keepsHeld } from "./held"
import { cancelledMessage, notSentMessage } from "./messages"
import { continueRun, runEvents } from "./sign-again"
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
// nothing was sent, so the run stops there, and signing again continues it from the same
// prepared transactions. It is never answered by `runs.retry` (the service refuses it
// while a prepared transaction can still land) or by a second `runs.create`. Any other
// stop lets go of the transactions after it: they are never signed.

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

const [bruno, , diego, northwind] = seedPeople
const SIG = "5SigMockSignature1111111111111111111111111111"

const refusal = () =>
  Object.assign(new Error("denied"), { name: "UserRejectedRequestError" })

// The hook's own wiring (`runEvents`, `continueRun`) over the reducer, a held store on a
// clock the test moves, and the real signing flow.
function harness(signer: Signer, submit = mockSubmit) {
  const retry = vi.fn<RunApi["retry"]>((runId, request) =>
    api.runs.retry(runId, request),
  )
  const runApi: RunApi = {
    confirm: (runId, item) => api.runs.confirm(runId, { payments: [item] }),
    retry,
  }
  const create = vi.spyOn(api.runs, "create")
  let height = 0
  const blockHeight = vi.fn(async () => height)
  const held = createHeldStore()
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
  const context = (run: Run, signal?: AbortSignal): RunContext => ({
    runId: run.run_id,
    sign,
    api: runApi,
    events,
    signal,
  })
  return {
    held,
    blockHeight,
    retry,
    create,
    local: () => local,
    // The finalized block height the run reads from now on.
    at: (finalized: number) => (height = finalized),
    // What the hook's `start` does: hold everything, then sign in order.
    start: (run: Run) => {
      for (const prepared of signablesOf(run)) {
        held.hold(paymentKey(run.run_id, prepared.position), prepared)
      }
      return continueRun(context(run), held, blockHeight)
    },
    // What the hook's `signAgain` does.
    signAgain: (run: Run, signal?: AbortSignal) =>
      continueRun(context(run, signal), held, blockHeight),
    // How a row reads against what the service says now.
    row: async (run: Run, position: number) => {
      const read = await api.runs.get(run.run_id)
      const key = paymentKey(run.run_id, position)
      return mergeRow(
        local[key],
        read.payments.find((p) => p.position === position),
        held.has(key),
      )
    },
  }
}

async function createRun(...people: string[]) {
  return api.runs.create({
    company_wallet: COMPANY_WALLET,
    sender: mockTokenAccount(COMPANY_WALLET),
    aes_key: "AAAAAAAAAAAAAAAAAAAAAA==",
    wallet_signature: SIG,
    payments: (people.length ? people : [bruno.id, diego.id]).map((id) => ({
      recipient: mockTokenAccount(id),
      amount: "1000000000",
    })),
  })
}

// A signer whose refusals the test switches on and off, recording what it signed.
function switchable() {
  const base = mockSigner(COMPANY_WALLET)
  const state = { refuse: true, signed: [] as string[] }
  const signer: Signer = {
    address: base.address,
    signTransaction: async (bytes) => {
      if (state.refuse) throw refusal()
      state.signed.push(Buffer.from(bytes).toString("base64"))
      return base.signTransaction(bytes)
    },
  }
  return { signer, state }
}

describe("a cancelled signature in a run", () => {
  it("stops the run there, and signing again continues it from the same transactions", async () => {
    scenarios.set("instant")
    const run = await createRun()
    const [first, second] = run.payments
    const { signer, state } = switchable()
    const h = harness(signer)
    const createCalls = h.create.mock.calls.length

    await h.start(run)

    // Cancelled: not retryable, not sent, still held, and the next one never asked.
    const row = await h.row(run, 0)
    expect(row.status).toBe("cancelled")
    expect(canSignAgain(row)).toBe(true)
    expect(canRetry(row)).toBe(false)
    expect(canRecheck(row)).toBe(false)
    expect(row.message).toBe(cancelledMessage)
    expect(h.held.lookup(paymentKey(run.run_id, 0), 0).status).toBe("ready")
    expect((await h.row(run, 1)).status).toBe("pending")
    // The service would refuse a retry: a prepared transaction can still land.
    await expect(
      api.runs.retry(run.run_id, {
        aes_key: "AAAAAAAAAAAAAAAAAAAAAA==",
        payments: [{ position: 0, amount: "1000000000" }],
      }),
    ).rejects.toMatchObject({ code: "original_signature_required" })

    // Sign again: the held transactions, as prepared, in order.
    state.refuse = false
    await h.signAgain(run)

    expect((await h.row(run, 0)).status).toBe("confirmed")
    expect((await h.row(run, 1)).status).toBe("confirmed")
    expect(state.signed).toEqual([first.transaction, second.transaction])
    expect(h.held.ofRun(run.run_id)).toEqual([])
    expect(h.retry).not.toHaveBeenCalled()
    expect(h.create.mock.calls.length).toBe(createCalls)
    expect(
      db.payments.filter((p) => p.personId === bruno.id && p.runId !== null),
    ).toHaveLength(1)
  })

  it("stays held and signable when the signature is cancelled twice", async () => {
    const run = await createRun()
    const { signer } = switchable()
    const h = harness(signer)

    await h.start(run)
    await h.signAgain(run)

    expect(h.local()[paymentKey(run.run_id, 0)].status).toBe("cancelled")
    expect(h.held.lookup(paymentKey(run.run_id, 0), 0).status).toBe("ready")
    expect(h.held.ofRun(run.run_id)).toHaveLength(2)
  })

  it("resumes from the payment it stopped at, not from the start", async () => {
    scenarios.set("instant")
    const run = await createRun(bruno.id, diego.id, northwind.id)
    const base = mockSigner(COMPANY_WALLET)
    let calls = 0
    const signed: string[] = []
    const h = harness({
      address: base.address,
      signTransaction: async (bytes) => {
        // The second signature is turned down once.
        if (++calls === 2) throw refusal()
        signed.push(Buffer.from(bytes).toString("base64"))
        return base.signTransaction(bytes)
      },
    })

    await h.start(run)
    expect((await h.row(run, 0)).status).toBe("confirmed")
    expect((await h.row(run, 1)).status).toBe("cancelled")
    expect((await h.row(run, 2)).status).toBe("pending")

    await h.signAgain(run)
    expect(signed).toEqual(run.payments.map((p) => p.transaction))
    expect((await api.runs.get(run.run_id)).status).toBe("completed")
  })
})

describe("a run that stops for anything but a cancelled signature", () => {
  it("lets go of the payments after it: they read as not sent, and nothing is offered", async () => {
    scenarios.set("instant")
    const run = await createRun()
    // The transaction leaves and the connection drops before the answer.
    const h = harness(mockSigner(COMPANY_WALLET), async () => {
      throw new Error("socket closed")
    })

    await h.start(run)

    const first = mergeRow(h.local()[paymentKey(run.run_id, 0)])
    expect(first.status).toBe("unknown")
    expect(canSignAgain(first)).toBe(false)
    expect(canRetry(first)).toBe(false)
    expect(h.held.ofRun(run.run_id)).toEqual([])
    const second = await h.row(run, 1)
    expect(second).toMatchObject({
      status: "not-sent",
      message: notSentMessage,
    })
    expect(canSignAgain(second)).toBe(false)
    expect(canRetry(second)).toBe(false)
  })

  it("is not re-signed when the network took it and confirming failed", async () => {
    const run = await createRun()
    const h = harness(mockSigner(COMPANY_WALLET))
    // Submitted, then the service goes down.
    scenarios.set("service-down")

    await h.start(run)

    const row = mergeRow(h.local()[paymentKey(run.run_id, 0)])
    expect(row.status).toBe("waiting")
    expect(row.stalled).toBe(true)
    expect(canSignAgain(row)).toBe(false)
    expect(h.held.ofRun(run.run_id)).toEqual([])
  })

  it("is told apart from a refusal by the network, which stays a failure to retry", async () => {
    scenarios.set("partial-failure", "instant")
    const run = await createRun(bruno.id, diego.id, northwind.id)
    const h = harness(mockSigner(COMPANY_WALLET))

    await h.start(run)

    expect((await h.row(run, 0)).status).toBe("confirmed")
    const failed = await h.row(run, 1)
    expect(failed.status).toBe("failed")
    expect(canRetry(failed)).toBe(true)
    expect(canSignAgain(failed)).toBe(false)
    // The third was built for a balance that did not come to be: never signed.
    expect((await h.row(run, 2)).status).toBe("not-sent")
    expect(h.held.ofRun(run.run_id)).toEqual([])
    expect(db.payments.filter((p) => p.runId === run.run_id)).toHaveLength(1)
  })
})

describe("signing again past the life of a blockhash", () => {
  it("lets go of the held transactions, signs nothing, and they read as not sent", async () => {
    scenarios.set("instant")
    const run = await createRun()
    const base = mockSigner(COMPANY_WALLET)
    const signTransaction = vi.fn(async () => {
      throw refusal()
    })
    const h = harness({ address: base.address, signTransaction })
    await h.start(run)
    expect(signTransaction).toHaveBeenCalledTimes(1)

    h.at(run.payments[0].last_valid_block_height! - heldMarginBlocks + 1)
    await h.signAgain(run)

    // Nothing was signed or submitted again, and nothing was prepared.
    expect(signTransaction).toHaveBeenCalledTimes(1)
    expect(h.retry).not.toHaveBeenCalled()
    expect(h.held.ofRun(run.run_id)).toEqual([])
    for (const position of [0, 1]) {
      const row = await h.row(run, position)
      expect(row).toMatchObject({ status: "not-sent", message: notSentMessage })
      expect(canRetry(row)).toBe(false)
      expect(canSignAgain(row)).toBe(false)
    }
  })

  it("still signs it again at the last height that leaves it time to land", async () => {
    scenarios.set("instant")
    const run = await createRun()
    const { signer, state } = switchable()
    const h = harness(signer)
    await h.start(run)
    state.refuse = false

    h.at(run.payments[0].last_valid_block_height! - heldMarginBlocks)
    await h.signAgain(run)

    expect(h.local()[paymentKey(run.run_id, 0)].status).toBe("confirmed")
  })

  it("reads the height again before each one, and lets go of one that went stale meanwhile", async () => {
    scenarios.set("instant")
    const run = await createRun()
    const [first, second] = run.payments
    const { signer, state } = switchable()
    const h = harness(signer)
    await h.start(run)
    state.refuse = false

    // The first still has time; by the time it is confirmed, the second has none.
    h.blockHeight.mockReset()
    h.blockHeight
      .mockResolvedValueOnce(first.last_valid_block_height! - heldMarginBlocks)
      .mockResolvedValueOnce(
        second.last_valid_block_height! - heldMarginBlocks + 1,
      )
    await h.signAgain(run)

    expect(h.blockHeight).toHaveBeenCalledTimes(2)
    expect(state.signed).toHaveLength(1)
    expect((await h.row(run, 0)).status).toBe("confirmed")
    expect(await h.row(run, 1)).toMatchObject({
      status: "not-sent",
      message: notSentMessage,
    })
    expect(h.held.ofRun(run.run_id)).toEqual([])
  })

  it("lets go of them when the height cannot be read, since nothing says they are live", async () => {
    scenarios.set("instant")
    const run = await createRun()
    const { signer, state } = switchable()
    const h = harness(signer)
    await h.start(run)
    state.refuse = false

    h.blockHeight.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    await h.signAgain(run)

    expect(state.signed).toEqual([])
    expect(h.held.ofRun(run.run_id)).toEqual([])
    expect((await h.row(run, 0)).status).toBe("not-sent")
  })

  it("keeps them held when the page is left during the height read", async () => {
    scenarios.set("instant")
    const run = await createRun()
    const { signer, state } = switchable()
    const h = harness(signer)
    await h.start(run)
    state.refuse = false

    const leave = new AbortController()
    h.blockHeight.mockImplementationOnce(async () => {
      leave.abort(new Error("left"))
      throw leave.signal.reason
    })
    await h.signAgain(run, leave.signal)

    expect(state.signed).toEqual([])
    expect(h.held.ofRun(run.run_id).map((p) => p.position)).toEqual([0, 1])
  })

  it("signs nothing for a run this page does not hold", async () => {
    const run = await createRun()
    const base = mockSigner(COMPANY_WALLET)
    const signTransaction = vi.fn(base.signTransaction)
    const h = harness({ address: base.address, signTransaction })

    await h.signAgain(run)

    expect(signTransaction).not.toHaveBeenCalled()
    expect(h.local()).toEqual({})
  })
})

describe("what each event does to a held transaction", () => {
  const held = (...ids: string[]) => {
    const store = createHeldStore()
    for (const [position, id] of ids.entries()) {
      const prepared: Signable = {
        position,
        destination: `account${position}`,
        attempt: 0,
        request_id: "a".repeat(64),
        status: "prepared",
        signature: null,
        slot: null,
        error: null,
        transaction: "AQID",
        last_valid_block_height: 1,
        required_signers: ["wallet"],
      }
      store.hold(id, prepared)
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
