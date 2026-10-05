import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  clearSubmission,
  createRecordList,
  readSubmission,
  recordSubmission,
  stableHash,
  viewerScopeId,
  type SubmissionStorage,
} from "./submissions"

function fakeStorage(): SubmissionStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}

const throwing: SubmissionStorage = {
  getItem: () => {
    throw new Error("blocked")
  },
  setItem: () => {
    throw new Error("blocked")
  },
  removeItem: () => {
    throw new Error("blocked")
  },
}

const record = {
  kind: "wrap",
  request_id: "a".repeat(64),
  signature: null,
  last_valid_block_height: 1234,
  wallet: "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5",
  at: 1_000,
}

describe("submissions", () => {
  it("reads back what was recorded", () => {
    const storage = fakeStorage()
    recordSubmission(record, storage)
    expect(readSubmission("wrap", storage)).toEqual(record)
  })

  it("keeps what was pending before a deposit, and reads a record from before that field existed", () => {
    const storage = fakeStorage()
    recordSubmission({ ...record, earlier_pending: "200000000" }, storage)
    expect(readSubmission("wrap", storage)?.earlier_pending).toBe("200000000")
    // The record above has no such field and is still valid.
    clearSubmission("wrap", storage)
    recordSubmission(record, storage)
    expect(readSubmission("wrap", storage)).toEqual(record)
    expect(readSubmission("wrap", storage)).not.toHaveProperty(
      "earlier_pending",
    )
  })

  it("drops a record whose earlier_pending is not digits", () => {
    const storage = fakeStorage()
    storage.setItem(
      "cadence:submission:wrap",
      JSON.stringify({ ...record, earlier_pending: "-5" }),
    )
    expect(readSubmission("wrap", storage)).toBeNull()
  })

  it("stamps the time when none is given", () => {
    const storage = fakeStorage()
    const before = Date.now()
    const saved = recordSubmission({ ...record, at: undefined }, storage)
    expect(saved.at).toBeGreaterThanOrEqual(before)
    expect(readSubmission("wrap", storage)?.at).toBe(saved.at)
  })

  it("keeps one record per kind and lets a newer one replace the last", () => {
    const storage = fakeStorage()
    recordSubmission(record, storage)
    recordSubmission({ ...record, kind: "unwrap", request_id: "b" }, storage)
    recordSubmission({ ...record, signature: "SIG" }, storage)
    expect(readSubmission("wrap", storage)?.signature).toBe("SIG")
    expect(readSubmission("unwrap", storage)?.request_id).toBe("b")
  })

  it("clears one kind and leaves the others", () => {
    const storage = fakeStorage()
    recordSubmission(record, storage)
    recordSubmission({ ...record, kind: "unwrap" }, storage)
    clearSubmission("wrap", storage)
    expect(readSubmission("wrap", storage)).toBeNull()
    expect(readSubmission("unwrap", storage)).not.toBeNull()
  })

  it("is null when nothing was recorded", () => {
    expect(readSubmission("wrap", fakeStorage())).toBeNull()
  })

  it("drops a stored value that is not a record", () => {
    const storage = fakeStorage()
    for (const bad of [
      "not json",
      "{}",
      JSON.stringify({ ...record, last_valid_block_height: -1 }),
      JSON.stringify({ ...record, kind: "other" }),
    ]) {
      storage.items.set("cadence:submission:wrap", bad)
      expect(readSubmission("wrap", storage)).toBeNull()
      expect(storage.items.has("cadence:submission:wrap")).toBe(false)
    }
  })

  it("works without storage: nothing throws and nothing is found", () => {
    for (const storage of [null, throwing]) {
      expect(() => recordSubmission(record, storage)).not.toThrow()
      expect(readSubmission("wrap", storage)).toBeNull()
      expect(() => clearSubmission("wrap", storage)).not.toThrow()
    }
  })

  it("returns the record it tried to save even when storage refuses", () => {
    expect(recordSubmission(record, throwing)).toEqual(record)
  })
})

describe("stableHash", () => {
  it("is stable, short and holds nothing of what it was made from", () => {
    const id = stableHash("Solaris", "ana@example.com")
    expect(id).toBe(stableHash("Solaris", "ana@example.com"))
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(id).not.toContain("ana")
  })

  it("tells viewers apart, and one split of the same text from another", () => {
    const a = { company: "Solaris", email: "ana@example.com" }
    expect(viewerScopeId(a)).toBe(viewerScopeId({ ...a }))
    expect(viewerScopeId(a)).not.toBe(viewerScopeId({ ...a, email: "b@x.io" }))
    expect(viewerScopeId(a)).not.toBe(viewerScopeId({ ...a, company: "Other" }))
    expect(stableHash("ab", "c")).not.toBe(stableHash("a", "bc"))
  })
})

describe("createRecordList", () => {
  const schema = z.object({ id: z.string().min(1), n: z.number() })
  type Item = z.infer<typeof schema>
  const make = (storage: SubmissionStorage | null, scope = "s1") =>
    createRecordList<Item>({
      kind: "things",
      scope,
      schema,
      same: (a, b) => a.id === b.id,
      storage,
    })

  it("reads back what another list over the same storage wrote, as after a reload", () => {
    const storage = fakeStorage()
    const first = make(storage)
    first.upsert({ id: "a", n: 1 })
    first.upsert({ id: "b", n: 2 })
    expect(make(storage).read()).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ])
  })

  it("replaces the record that matches and keeps the rest in order", () => {
    const list = make(fakeStorage())
    list.upsert({ id: "a", n: 1 })
    list.upsert({ id: "b", n: 2 })
    list.upsert({ id: "a", n: 3 })
    expect(list.read()).toEqual([
      { id: "a", n: 3 },
      { id: "b", n: 2 },
    ])
  })

  it("removes by predicate, and drops the key once the list is empty", () => {
    const storage = fakeStorage()
    const list = make(storage)
    list.upsert({ id: "a", n: 1 })
    list.upsert({ id: "b", n: 2 })
    list.remove((item) => item.id === "a")
    expect(list.read()).toEqual([{ id: "b", n: 2 }])
    list.remove((item) => item.id === "b")
    expect(list.read()).toEqual([])
    expect(storage.items.size).toBe(0)
  })

  it("returns the same array until something changes, and tells listeners when it does", () => {
    const list = make(fakeStorage())
    const listener = vi.fn()
    const stop = list.subscribe(listener)
    expect(list.read()).toBe(list.read())
    list.upsert({ id: "a", n: 1 })
    expect(listener).toHaveBeenCalledTimes(1)
    const before = list.read()
    list.remove((item) => item.id === "none")
    expect(list.read()).toBe(before)
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    list.upsert({ id: "b", n: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("keeps the valid entries and drops the others", () => {
    const storage = fakeStorage()
    storage.items.set(
      "cadence:submissions:things:s1",
      JSON.stringify([{ id: "a", n: 1 }, { id: "", n: 2 }, "x", { id: "b" }]),
    )
    expect(make(storage).read()).toEqual([{ id: "a", n: 1 }])
  })

  it("reads an empty list from a value that is not a list or not JSON", () => {
    for (const bad of ["not json", "{}", "null", "7"]) {
      const storage = fakeStorage()
      storage.items.set("cadence:submissions:things:s1", bad)
      expect(make(storage).read()).toEqual([])
    }
  })

  it("keeps each scope apart, so one viewer never reads another's records", () => {
    const storage = fakeStorage()
    make(storage, "ana").upsert({ id: "a", n: 1 })
    expect(make(storage, "bob").read()).toEqual([])
    make(storage, "bob").upsert({ id: "b", n: 2 })
    expect(make(storage, "ana").read()).toEqual([{ id: "a", n: 1 }])
  })

  it("works without storage, in memory for as long as the list lives", () => {
    for (const storage of [null, throwing]) {
      const list = make(storage)
      expect(list.read()).toEqual([])
      expect(() => list.upsert({ id: "a", n: 1 })).not.toThrow()
      expect(list.read()).toEqual([{ id: "a", n: 1 }])
      list.remove(() => true)
      expect(list.read()).toEqual([])
      // A new list over it (a reload) finds nothing.
      expect(make(storage).read()).toEqual([])
    }
  })

  it("does not touch the single record a flow keeps under its own kind", () => {
    const storage = fakeStorage()
    recordSubmission(record, storage)
    const list = make(storage)
    list.upsert({ id: "a", n: 1 })
    list.remove(() => true)
    expect(readSubmission("wrap", storage)).toEqual(record)
  })
})
