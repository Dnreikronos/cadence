import { describe, expect, it, vi } from "vitest"
import { browserProfile } from "./browser-profile"
import type { Acquired } from "./flow-lock"
import {
  releaseAfterMs,
  releaseMessage,
  releaseUnderLock,
  releaseUnreadableUnderLock,
} from "./release"
import { clearSettledEvidence, viewerScopeId } from "./submissions"
import {
  heldRecords,
  releaseHeldChecked,
  withdrawEvidence,
} from "./withdraw/held"
import {
  paymentSending,
  releasePersonChecked,
  runEvidence,
} from "./runs/evidence"

type Rec = { id: string; at: number }
const same = (a: Rec, b: Rec) => a.id === b.id && a.at === b.at

function lock(busy = false) {
  const log: string[] = []
  let held = 0
  return {
    log,
    held: () => held,
    take: async (): Promise<Acquired> => {
      if (busy) return { status: "busy" }
      held++
      log.push("locked")
      return {
        status: "held",
        lease: {
          release: () => {
            held--
            log.push("released")
          },
        },
      }
    },
  }
}

const NOW = 10_000_000
const old: Rec = { id: "a", at: NOW - releaseAfterMs }

function run(
  overrides: Partial<Parameters<typeof releaseUnderLock<Rec>>[0]> & {
    saved?: Rec[]
  } = {},
) {
  const { saved = [old], ...rest } = overrides
  const removed: Rec[][] = []
  const taken = lock()
  const outcome = releaseUnderLock<Rec>({
    lock: taken.take,
    read: () => {
      taken.log.push("read")
      return saved
    },
    seen: [old],
    same,
    remove: (records) => removed.push([...records]),
    now: NOW,
    ...rest,
  })
  return { outcome, removed, taken }
}

describe("releaseUnderLock", () => {
  it("releases the very record the person saw once it is two minutes old, under the lock", async () => {
    const { outcome, removed, taken } = run()
    expect(await outcome).toBe("released")
    expect(removed).toEqual([[old]])
    // Looked at again only once the lock was held, and let go afterwards.
    expect(taken.log).toEqual(["locked", "read", "released"])
  })

  it("refuses, and clears nothing, while another tab holds the lock", async () => {
    const removed: Rec[][] = []
    const read = vi.fn(() => [old])
    const taken = lock(true)
    expect(
      await releaseUnderLock<Rec>({
        lock: taken.take,
        read,
        seen: [old],
        same,
        remove: (records) => removed.push([...records]),
        now: NOW,
      }),
    ).toBe("busy")
    expect(read).not.toHaveBeenCalled()
    expect(removed).toEqual([])
  })

  it.each([
    ["it was replaced by a new send", [{ id: "a", at: NOW - 473 }]],
    ["it is another send", [{ id: "b", at: old.at }]],
    ["it is gone", []],
    ["there is one more", [old, { id: "b", at: old.at }]],
  ])("refuses when %s, and clears nothing", async (_, saved) => {
    const { outcome, removed, taken } = run({ saved })
    expect(await outcome).toBe("changed")
    expect(removed).toEqual([])
    expect(taken.held()).toBe(0)
  })

  it("refuses when the person saw nothing", async () => {
    const { outcome, removed } = run({ seen: [] })
    expect(await outcome).toBe("changed")
    expect(removed).toEqual([])
  })

  it("refuses before the two minutes are up, even for the very record seen", async () => {
    const recent = { id: "a", at: NOW - releaseAfterMs + 1 }
    const { outcome, removed } = run({ seen: [recent], saved: [recent] })
    expect(await outcome).toBe("too-soon")
    expect(removed).toEqual([])
  })

  it("lets go of the lock when reading or removing throws", async () => {
    const taken = lock()
    await expect(
      releaseUnderLock<Rec>({
        lock: taken.take,
        read: () => {
          throw new Error("blocked")
        },
        seen: [old],
        same,
        remove: () => {},
      }),
    ).rejects.toThrow()
    expect(taken.held()).toBe(0)
  })
})

describe("releaseUnreadableUnderLock", () => {
  it("clears under the lock, and not at all while another tab has it", async () => {
    const clear = vi.fn()
    const taken = lock()
    expect(await releaseUnreadableUnderLock(taken.take, clear)).toBe("released")
    expect(clear).toHaveBeenCalledTimes(1)
    expect(taken.held()).toBe(0)

    const busy = vi.fn()
    expect(await releaseUnreadableUnderLock(lock(true).take, busy)).toBe("busy")
    expect(busy).not.toHaveBeenCalled()
  })
})

describe("what the person reads", () => {
  it("says nothing when it went through, and says why when it did not", () => {
    expect(releaseMessage("released", "withdrawal")).toBeNull()
    expect(releaseMessage("busy", "withdrawal")).toMatch(/Another tab/)
    expect(releaseMessage("busy", "deposit")).toMatch(/a deposit/)
    expect(releaseMessage("changed", "run")).toMatch(/changed in another tab/)
    expect(releaseMessage("too-soon", "run")).toMatch(/two minutes/)
  })
})

// The case that matters: a tab that did not hear of a change (its storage events were
// swallowed) decides on what it saw, after another tab released and sent again.
describe("a release made on a stale view", () => {
  const bruno = { company: "Solaris", email: "bruno@solaris.test" }
  const ana = { company: "Solaris", email: "ana@solaris.test" }

  it("does not clear the withdrawal another tab sent after releasing the one this tab saw", async () => {
    const shared = browserProfile()
    const frozen = heldRecords(bruno, shared.tab())
    const active = heldRecords(bruno, shared.tab())
    withdrawEvidence(active, "5", () => 1_000).onSent({
      request_id: "a".repeat(64),
      last_valid_block_height: 1,
      signature: null,
    })
    const seen = frozen.read()[0]!
    // The other tab releases it and sends the same amount again: in flight, 473 ms old.
    active.remove(() => true)
    withdrawEvidence(active, "5", () => NOW - 473).onSent({
      request_id: "b".repeat(64),
      last_valid_block_height: 2,
      signature: null,
    })

    const outcome = await releaseHeldChecked({
      records: frozen,
      seen,
      lock: lock().take,
      now: NOW,
    })

    expect(outcome).toBe("changed")
    expect(active.read()).toHaveLength(1)
    expect(active.read()[0]).toMatchObject({ request_id: "b".repeat(64) })
  })

  it("clears only that record when it is still the one seen, and leaves other amounts alone", async () => {
    const shared = browserProfile()
    const records = heldRecords(bruno, shared.tab())
    withdrawEvidence(records, "5", () => 1_000).onSent({
      request_id: "a".repeat(64),
      last_valid_block_height: 1,
      signature: "sig",
    })
    withdrawEvidence(records, "6", () => 1_000).onSent({
      request_id: "c".repeat(64),
      last_valid_block_height: 1,
      signature: "sig",
    })
    const seen = records.read().find((r) => r.amount_units === "5")!

    const outcome = await releaseHeldChecked({
      records,
      seen,
      lock: lock().take,
      now: 1_000 + releaseAfterMs,
    })

    expect(outcome).toBe("released")
    expect(records.read().map((r) => r.amount_units)).toEqual(["6"])
  })

  it("refuses when the record gained a signature since, which is something to look up first", async () => {
    const shared = browserProfile()
    const frozen = heldRecords(bruno, shared.tab())
    const active = heldRecords(bruno, shared.tab())
    const evidence = withdrawEvidence(active, "5", () => 1_000)
    evidence.onSent({
      request_id: "a".repeat(64),
      last_valid_block_height: 1,
      signature: null,
    })
    const seen = frozen.read()[0]!
    evidence.onSent({
      request_id: "a".repeat(64),
      last_valid_block_height: 1,
      signature: "sig",
    })

    expect(
      await releaseHeldChecked({
        records: frozen,
        seen,
        lock: lock().take,
        now: 1_000 + releaseAfterMs,
      }),
    ).toBe("changed")
    expect(active.read()).toHaveLength(1)
  })

  it("does not clear another person's payment sent after the one this tab saw was released", async () => {
    const shared = browserProfile()
    const frozen = runEvidence(ana, shared.tab())
    const active = runEvidence(ana, shared.tab())
    const prepared = (n: number) => ({
      position: n,
      attempt: 0,
      request_id: String(n).repeat(64),
      last_valid_block_height: n,
    })
    paymentSending(active, "run", prepared(1), "person-1", 1_000)
    const seen = frozen.payments.read().slice()
    active.payments.remove(() => true)
    paymentSending(active, "run", prepared(2), "person-1", NOW - 473)

    const outcome = await releasePersonChecked({
      evidence: frozen,
      personId: "person-1",
      seen,
      lock: lock().take,
      now: NOW,
    })

    expect(outcome).toBe("changed")
    expect(active.payments.read()).toHaveLength(1)
    expect(active.payments.read()[0]).toMatchObject({ position: 2 })
  })

  it("releases a person's payments when they are what was seen", async () => {
    const shared = browserProfile()
    const evidence = runEvidence(ana, shared.tab())
    paymentSending(
      evidence,
      "run",
      {
        position: 0,
        attempt: 0,
        request_id: "1".repeat(64),
        last_valid_block_height: 1,
      },
      "person-1",
      1_000,
    )
    const seen = evidence.payments.read().slice()

    expect(
      await releasePersonChecked({
        evidence,
        personId: "person-1",
        seen,
        lock: lock().take,
        now: 1_000 + releaseAfterMs,
      }),
    ).toBe("released")
    expect(evidence.payments.read()).toEqual([])
  })

  it("keeps what signing out left, so the release is still on the right record", async () => {
    const shared = browserProfile()
    const records = heldRecords(bruno, shared.tab())
    withdrawEvidence(records, "5", () => 1_000).onSent({
      request_id: "a".repeat(64),
      last_valid_block_height: 1,
      signature: null,
    })
    clearSettledEvidence(bruno, shared.tab())
    expect(records.read()).toHaveLength(1)
    expect(viewerScopeId(bruno)).toMatch(/^[0-9a-f]{16}$/)
  })
})
