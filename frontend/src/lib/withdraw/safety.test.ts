import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import type { Receipt, UnwrapPrepared } from "@/lib/api/schemas"
import type { SignStep } from "@/lib/api/sign"
import {
  StorageUnavailableError,
  storageBlockedMessage,
} from "@/lib/storage-guard"
import type { SubmissionStorage } from "@/lib/submissions"
import { arrivalOf, checkState } from "./check-state"
import { failureOf, runWithdraw, SentWithdrawalError } from "./flow"
import type { WithdrawDeps } from "./flow"
import {
  canRelease,
  checkHeldWithdrawals,
  heldRecords,
  releaseAfterMs,
  releaseHeld,
  releaseWarning,
  withdrawEvidence,
  type HeldRecord,
} from "./held"

function fakeStorage(): SubmissionStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}

// Storage that refuses every write.
const refusing: SubmissionStorage = {
  getItem: () => null,
  setItem: () => {
    throw new Error("blocked")
  },
  removeItem: () => {},
}

const viewer = { company: "Solaris", email: "ana@example.com" }
const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const REQUEST = "a".repeat(64)
const SIG = "5SigMockSignature1111111111111111111111111111"
const receipt: Receipt = {
  request_id: REQUEST,
  signature: SIG,
  slot: 1,
  status: "finalized",
}
const prepared: UnwrapPrepared = {
  request_id: REQUEST,
  transaction: "AQID",
  transaction_version: 1,
  required_signers: [wallet],
  recent_blockhash: "hash",
  last_valid_block_height: 321,
  reveal_risk: { level: "none", matches: [] },
}
const record = (patch: Partial<HeldRecord> = {}): HeldRecord => ({
  amount_units: "1000000000",
  request_id: REQUEST,
  signature: SIG,
  last_valid_block_height: 321,
  at: 1_000,
  ...patch,
})
// The chain on a test clock that starts at 1000: the blockhash was read then, and has
// 150 blocks (60 s) of life.
const heightAt = (time: number) => 321 - 150 + Math.floor((time - 1_000) / 400)

// The flow as far as the send: `submit` is the thing that must not run when it should not.
function flowWith(submit: () => void): WithdrawDeps {
  return {
    prepare: vi.fn(async () => prepared),
    signAndConfirm: vi.fn(async (_p, _confirm, onStep, { onSubmitted }) => {
      for (const step of ["signing", "submitting"] as SignStep[]) onStep(step)
      submit()
      onSubmitted(SIG)
      return receipt
    }),
    confirm: vi.fn(async () => receipt),
  }
}

describe("a withdrawal when storage cannot keep its record", () => {
  const run = (
    d: WithdrawDeps,
    records: ReturnType<typeof heldRecords>,
    mode: "mock" | "real",
  ) =>
    runWithdraw(d, {
      wallet,
      amount: "1000000000",
      acknowledged: false,
      ...withdrawEvidence(records, "1000000000", () => 5_000, mode),
    })

  it("stops before the send in real mode, and says why, not that it may have been sent", async () => {
    const submit = vi.fn()
    const records = heldRecords(viewer, refusing)
    const failure = await run(flowWith(submit), records, "real").catch((e) => e)
    expect(submit).not.toHaveBeenCalled()
    expect(failure).toBeInstanceOf(StorageUnavailableError)
    expect(failure).not.toBeInstanceOf(SentWithdrawalError)
    // Nothing was sent, so nothing is held back in memory either.
    expect(records.read()).toEqual([])
    const shown = failureOf(failure)
    expect(shown.message).toBe(storageBlockedMessage)
    expect(shown.sent).toBe(false)
    expect(shown.retryable).toBe(true)
  })

  it("stops in real mode when storage had worked and then fails during the flow", async () => {
    let working = true
    const items = new Map<string, string>()
    const storage: SubmissionStorage = {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        if (!working) throw new Error("full")
        items.set(key, value)
      },
      removeItem: (key) => void items.delete(key),
    }
    const records = heldRecords(viewer, storage)
    const submit = vi.fn()
    const d = flowWith(submit)
    d.prepare = vi.fn(async () => {
      // It fills up between the probe and the prepare finishing.
      working = false
      return prepared
    })
    await expect(run(d, records, "real")).rejects.toBeInstanceOf(
      StorageUnavailableError,
    )
    expect(submit).not.toHaveBeenCalled()
  })

  it("goes on in mock mode, with the record held in memory", async () => {
    const submit = vi.fn()
    const records = heldRecords(viewer, refusing)
    await expect(run(flowWith(submit), records, "mock")).resolves.toMatchObject(
      { kind: "done" },
    )
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it("sends when storage works, in real mode", async () => {
    const submit = vi.fn()
    const storage = fakeStorage()
    const records = heldRecords(viewer, storage)
    await run(flowWith(submit), records, "real")
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it("does not undo a send because the signature could not be written: it is too late to stop", async () => {
    let writes = 0
    const items = new Map<string, string>()
    const storage: SubmissionStorage = {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        // The first write (before the send) works; the one with the signature does not.
        if (++writes > 1) throw new Error("full")
        items.set(key, value)
      },
      removeItem: (key) => void items.delete(key),
    }
    const records = heldRecords(viewer, storage)
    const submit = vi.fn()
    await expect(run(flowWith(submit), records, "real")).resolves.toMatchObject(
      { kind: "done" },
    )
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe("releasing a hold on purpose", () => {
  const now = 1_000 + releaseAfterMs

  it("is not offered before two minutes have passed", () => {
    expect(canRelease(record(), { now: now - 1, lookedUp: true })).toBe(false)
    expect(
      canRelease(record({ signature: undefined }), {
        now: now - 1,
        lookedUp: false,
      }),
    ).toBe(false)
  })

  it("is offered for a record with no signature after two minutes: there is nothing to ask", () => {
    expect(
      canRelease(record({ signature: undefined }), { now, lookedUp: false }),
    ).toBe(true)
  })

  it("is offered for one with a signature only once a lookup came back unknown", () => {
    expect(canRelease(record(), { now, lookedUp: false })).toBe(false)
    expect(canRelease(record(), { now, lookedUp: true })).toBe(true)
  })

  it("frees the amount, and only that amount, for the viewer who releases it", () => {
    const storage = fakeStorage()
    const records = heldRecords(viewer, storage)
    records.upsert(record())
    records.upsert(record({ amount_units: "2000000000" }))
    const others = heldRecords({ ...viewer, email: "b@example.com" }, storage)
    others.upsert(record())
    releaseHeld(records, "1000000000")
    expect(records.read().map((r) => r.amount_units)).toEqual(["2000000000"])
    expect(others.read()).toHaveLength(1)
    // It stays released after a reload.
    expect(
      heldRecords(viewer, storage)
        .read()
        .map((r) => r.amount_units),
    ).toEqual(["2000000000"])
  })

  it("is warned about in plain words: the earlier withdrawal may still have been sent", () => {
    expect(releaseWarning).toMatch(/may still have been sent/)
    expect(releaseWarning).toMatch(/twice/)
    expect(releaseWarning).toMatch(/balance and history/)
  })
})

describe("saved withdrawals that cannot be read", () => {
  it("hold the whole viewer until they are released", () => {
    const storage = fakeStorage()
    const first = heldRecords(viewer, storage)
    first.upsert(record())
    const [key] = [...storage.items.keys()]
    storage.items.set(key, JSON.stringify([record(), { amount_units: "x" }]))
    const reloaded = heldRecords(viewer, storage)
    expect(reloaded.read()).toHaveLength(1)
    expect(reloaded.unreadable()).toBe(true)
    // Another viewer is not held by it.
    expect(
      heldRecords({ ...viewer, email: "b@example.com" }, storage).unreadable(),
    ).toBe(false)
    reloaded.clearUnreadable()
    expect(reloaded.unreadable()).toBe(false)
    expect(heldRecords(viewer, storage).unreadable()).toBe(false)
  })
})

describe("looking up several held withdrawals", () => {
  it("asks about one at a time, never two at once", async () => {
    const records = heldRecords(viewer, fakeStorage())
    records.upsert(record({ amount_units: "1", signature: "A" }))
    records.upsert(record({ amount_units: "2", signature: "B" }))
    let active = 0
    let overlap = 0
    const confirm = vi.fn(async () => {
      active += 1
      overlap = Math.max(overlap, active)
      await Promise.resolve()
      active -= 1
      throw new ApiError(409, "transaction_not_finalized")
    })
    let time = 1_000
    await checkHeldWithdrawals({
      records,
      api: { unwrap: { confirm } },
      refresh: () => {},
      blockHeight: async () => heightAt(time),
      sleep: async (ms) => void (time += ms),
    })
    expect(overlap).toBe(1)
  })

  it("spaces its asks by four seconds by default: one confirm every 4 s overall", async () => {
    const records = heldRecords(viewer, fakeStorage())
    records.upsert(record({ amount_units: "1", signature: "A" }))
    records.upsert(record({ amount_units: "2", signature: "B" }))
    const at: number[] = []
    let time = 1_000
    const confirm = vi.fn(async () => {
      at.push(time)
      throw new ApiError(409, "transaction_not_finalized")
    })
    await checkHeldWithdrawals({
      records,
      api: { unwrap: { confirm } },
      refresh: () => {},
      blockHeight: async () => heightAt(time),
      sleep: async (ms) => void (time += ms),
    })
    // The first record is asked at t=1000, 5000, ... until the chain is past its last
    // valid block (t=65000, 17 asks); the second only after that.
    const gaps = at.slice(1).map((t, i) => t - at[i])
    expect(Math.max(...gaps)).toBeLessThanOrEqual(4_000)
    expect(at.filter((t) => heightAt(t) > 321)).toHaveLength(2)
    // Never two asks at the same instant.
    expect(new Set(at).size).toBe(at.length)
  })
})

describe("checkState: when the screen looks up what it kept", () => {
  const a = record({ amount_units: "1", signature: "A" })
  const b = record({ amount_units: "2", signature: "B" })

  it("looks at what was held on arrival, and not at a withdrawal that failed since", () => {
    const arrival = arrivalOf([a])
    const state = checkState({
      records: [a, b],
      arrival,
      tick: 0,
      running: false,
    })
    expect(state.checking).toBe(true)
    expect(state.key).toBe("1:A")
    expect(state.include(a)).toBe(true)
    expect(state.include(b)).toBe(false)
  })

  it("looks at all of them once the person asks again", () => {
    const state = checkState({
      records: [a, b],
      arrival: arrivalOf([a]),
      tick: 1,
      running: false,
    })
    expect(state.key).toBe("1:A|2:B")
    expect(state.include(b)).toBe(true)
  })

  it("does not look while a withdrawal is running", () => {
    expect(
      checkState({
        records: [a],
        arrival: arrivalOf([a]),
        tick: 0,
        running: true,
      }).checking,
    ).toBe(false)
  })

  it("does not look twice at the same saved signatures, until asked again", () => {
    const base = { records: [a], arrival: arrivalOf([a]), running: false }
    expect(
      checkState({ ...base, tick: 0, checked: { key: "1:A", tick: 0 } })
        .checking,
    ).toBe(false)
    expect(
      checkState({ ...base, tick: 1, checked: { key: "1:A", tick: 0 } })
        .checking,
    ).toBe(true)
  })

  it("has nothing to look at without a saved signature, or with nothing held", () => {
    const bare = record({ signature: undefined })
    expect(
      checkState({
        records: [bare],
        arrival: arrivalOf([bare]),
        tick: 0,
        running: false,
      }).checking,
    ).toBe(false)
    expect(
      checkState({
        records: [],
        arrival: arrivalOf([]),
        tick: 3,
        running: false,
      }).checking,
    ).toBe(false)
  })

  it("keeps looking when new saved signatures arrive for what was checked", () => {
    const state = checkState({
      records: [a],
      arrival: arrivalOf([a]),
      tick: 1,
      checked: { key: "", tick: 0 },
      running: false,
    })
    expect(state.checking).toBe(true)
  })
})
