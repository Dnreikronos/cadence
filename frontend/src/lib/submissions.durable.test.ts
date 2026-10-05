import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  createRecordList,
  legacyViewerScopeIds,
  noteWriteFailure,
  persisted,
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

// Storage that refuses every write: blocked site data, or private browsing in some browsers.
function refusing(): SubmissionStorage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("QuotaExceededError")
    },
    removeItem: () => {},
  }
}

// Storage that accepts a write and then does not hold it.
function forgetful(): SubmissionStorage {
  return { getItem: () => null, setItem: () => {}, removeItem: () => {} }
}

describe("persisted", () => {
  it("is true for storage that holds what it is given, and leaves nothing behind", () => {
    const storage = fakeStorage()
    expect(persisted(storage)).toBe(true)
    expect(storage.items.size).toBe(0)
  })

  it("is false with no storage, with storage that refuses a write, and with storage that does not keep it", () => {
    expect(persisted(null)).toBe(false)
    expect(persisted(refusing())).toBe(false)
    expect(persisted(forgetful())).toBe(false)
    expect(
      persisted({
        getItem: () => {
          throw new Error("blocked")
        },
        setItem: () => {},
        removeItem: () => {},
      }),
    ).toBe(false)
  })

  it("remembers a pass for the page, so it does not write again", () => {
    const storage = fakeStorage()
    const set = vi.spyOn(storage, "setItem")
    expect(persisted(storage)).toBe(true)
    expect(persisted(storage)).toBe(true)
    expect(persisted(storage)).toBe(true)
    expect(set).toHaveBeenCalledTimes(1)
  })

  it("never remembers a failure: enabling storage is noticed at once", () => {
    let blocked = true
    const items = new Map<string, string>()
    const storage: SubmissionStorage = {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        if (blocked) throw new Error("blocked")
        items.set(key, value)
      },
      removeItem: (key) => void items.delete(key),
    }
    expect(persisted(storage)).toBe(false)
    blocked = false
    expect(persisted(storage)).toBe(true)
  })

  it("looks again after a real write failed, and finds the storage gone", () => {
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
    expect(persisted(storage)).toBe(true)
    working = false
    // Without the failure being noted, the pass is still remembered.
    expect(persisted(storage)).toBe(true)
    noteWriteFailure(storage)
    expect(persisted(storage)).toBe(false)
  })

  it("is told of a failed write by a record, and looks again", () => {
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
    expect(persisted(storage)).toBe(true)
    working = false
    recordSubmission(
      {
        kind: "wrap",
        request_id: "a",
        signature: null,
        last_valid_block_height: 1,
        wallet: "w",
      },
      storage,
    )
    expect(persisted(storage)).toBe(false)
    // Space comes back: the next look says so.
    working = true
    expect(persisted(storage)).toBe(true)
    expect(readSubmission("wrap", storage)).toBeNull()
  })
})

describe("a record list that cannot write", () => {
  const schema = z.object({ id: z.string().min(1) })
  const make = (storage: SubmissionStorage | null) =>
    createRecordList({
      kind: "things",
      scope: "s",
      schema,
      same: (a, b) => a.id === b.id,
      storage,
    })

  it("says whether an upsert reached storage", () => {
    expect(make(fakeStorage()).upsert({ id: "a" })).toBe(true)
    expect(make(refusing()).upsert({ id: "a" })).toBe(false)
    expect(make(null).upsert({ id: "a" })).toBe(false)
  })

  it("still holds the record in memory, and makes the next probe look again", () => {
    const storage = refusing()
    expect(persisted(storage)).toBe(false)
    const list = make(storage)
    list.upsert({ id: "a" })
    expect(list.read()).toEqual([{ id: "a" }])
  })
})

describe("saved entries that cannot be read", () => {
  const schema = z.object({ id: z.string().min(1), n: z.number().optional() })
  const kind = "things"
  const key = "cadence:submissions:things:s"
  const aside = `${key}:unreadable`
  const make = (storage: SubmissionStorage) =>
    createRecordList({
      kind,
      scope: "s",
      schema,
      same: (a, b) => a.id === b.id,
      storage,
    })

  it("are kept aside, not dropped, and the whole list reads as unreadable", () => {
    const storage = fakeStorage()
    storage.items.set(key, JSON.stringify([{ id: "a" }, { id: "" }, "x"]))
    const list = make(storage)
    expect(list.read()).toEqual([{ id: "a" }])
    expect(list.unreadable()).toBe(true)
    expect(JSON.parse(storage.items.get(aside)!)).toEqual([{ id: "" }, "x"])
  })

  it("are not erased by a later write, nor by emptying the list", () => {
    const storage = fakeStorage()
    storage.items.set(key, JSON.stringify([{ id: "a" }, { nope: true }]))
    const list = make(storage)
    list.upsert({ id: "b" })
    list.remove(() => true)
    expect(list.read()).toEqual([])
    expect(list.unreadable()).toBe(true)
    expect(JSON.parse(storage.items.get(aside)!)).toEqual([{ nope: true }])
    // After a reload they are still there.
    expect(make(storage).unreadable()).toBe(true)
  })

  it("keep a value that is not JSON, or not a list, as it was", () => {
    for (const raw of ["not json", "{}", "7"]) {
      const storage = fakeStorage()
      storage.items.set(key, raw)
      const list = make(storage)
      expect(list.read()).toEqual([])
      expect(list.unreadable()).toBe(true)
      expect(JSON.parse(storage.items.get(aside)!)).toEqual([raw])
    }
  })

  it("are released only on purpose, and then the list is clear", () => {
    const storage = fakeStorage()
    storage.items.set(key, JSON.stringify([{ id: "a" }, "x"]))
    const list = make(storage)
    const listener = vi.fn()
    list.subscribe(listener)
    expect(list.unreadable()).toBe(true)
    list.clearUnreadable()
    expect(list.unreadable()).toBe(false)
    expect(storage.items.has(aside)).toBe(false)
    expect(listener).toHaveBeenCalled()
    // The readable record was not touched by the release.
    expect(list.read()).toEqual([{ id: "a" }])
    expect(make(storage).unreadable()).toBe(false)
  })

  it("stay unreadable for the page when storage refuses to keep them aside", () => {
    const items = new Map<string, string>([[key, JSON.stringify(["x"])]])
    const storage: SubmissionStorage = {
      getItem: (k) => items.get(k) ?? null,
      setItem: () => {
        throw new Error("full")
      },
      removeItem: (k) => void items.delete(k),
    }
    expect(make(storage).unreadable()).toBe(true)
  })

  it("is not set off by a list that reads cleanly", () => {
    const storage = fakeStorage()
    storage.items.set(key, JSON.stringify([{ id: "a" }]))
    expect(make(storage).unreadable()).toBe(false)
  })

  it("reads an older entry that lacks a field added since, since fields are only ever added as optional", () => {
    const storage = fakeStorage()
    // Written before `n` existed.
    storage.items.set(key, JSON.stringify([{ id: "a" }]))
    const list = make(storage)
    expect(list.read()).toEqual([{ id: "a" }])
    expect(list.unreadable()).toBe(false)
  })

  it("makes an entry unreadable when a required field is missing or has the wrong type", () => {
    const storage = fakeStorage()
    storage.items.set(key, JSON.stringify([{ id: "a", n: "five" }]))
    const list = make(storage)
    expect(list.read()).toEqual([])
    expect(list.unreadable()).toBe(true)
  })
})

describe("scoping by company id", () => {
  const viewer = {
    company: "Solaris",
    companyId: "c0000000-0000-4000-8000-000000000001",
    email: "ana@example.com",
  }
  const schema = z.object({ id: z.string().min(1) })
  const make = (storage: SubmissionStorage, who = viewer) =>
    createRecordList({
      kind: "things",
      scope: viewerScopeId(who),
      legacyScopes: legacyViewerScopeIds(who),
      schema,
      same: (a, b) => a.id === b.id,
      storage,
    })

  it("is by the id when there is one, so a rename keeps the records", () => {
    const renamed = { ...viewer, company: "Solaris Brasil" }
    expect(viewerScopeId(renamed)).toBe(viewerScopeId(viewer))
    expect(viewerScopeId({ ...viewer, companyId: "other" })).not.toBe(
      viewerScopeId(viewer),
    )
    // Without an id it is by the name, as before.
    expect(viewerScopeId({ company: "Solaris", email: viewer.email })).toBe(
      stableHash("Solaris", viewer.email),
    )
  })

  it("names the old name-based scope as a legacy one, and none when there is nothing to migrate from", () => {
    expect(legacyViewerScopeIds(viewer)).toEqual([
      stableHash("Solaris", viewer.email),
    ])
    expect(
      legacyViewerScopeIds({ company: "Solaris", email: viewer.email }),
    ).toEqual([])
  })

  it("reads records saved under the name once, merges them in, and deletes the old key", () => {
    const storage = fakeStorage()
    const oldKey = `cadence:submissions:things:${stableHash("Solaris", viewer.email)}`
    const newKey = `cadence:submissions:things:${viewerScopeId(viewer)}`
    storage.items.set(oldKey, JSON.stringify([{ id: "old" }, { id: "both" }]))
    storage.items.set(newKey, JSON.stringify([{ id: "new" }, { id: "both" }]))
    const list = make(storage)
    expect(
      list
        .read()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["both", "new", "old"])
    expect(storage.items.has(oldKey)).toBe(false)
    expect(JSON.parse(storage.items.get(newKey)!)).toHaveLength(3)
    // A reload finds them under the id, and the old key does not come back.
    expect(make(storage).read()).toHaveLength(3)
    expect(storage.items.has(oldKey)).toBe(false)
  })

  it("migrates when there is nothing under the id yet", () => {
    const storage = fakeStorage()
    const oldKey = `cadence:submissions:things:${stableHash("Solaris", viewer.email)}`
    storage.items.set(oldKey, JSON.stringify([{ id: "old" }]))
    expect(make(storage).read()).toEqual([{ id: "old" }])
    expect(storage.items.has(oldKey)).toBe(false)
    expect(
      JSON.parse(
        storage.items.get(
          `cadence:submissions:things:${viewerScopeId(viewer)}`,
        )!,
      ),
    ).toEqual([{ id: "old" }])
  })

  it("keeps an unreadable old entry aside rather than dropping it in the move", () => {
    const storage = fakeStorage()
    const oldKey = `cadence:submissions:things:${stableHash("Solaris", viewer.email)}`
    storage.items.set(oldKey, JSON.stringify([{ id: "old" }, { broken: 1 }]))
    const list = make(storage)
    expect(list.read()).toEqual([{ id: "old" }])
    expect(list.unreadable()).toBe(true)
    expect(storage.items.has(oldKey)).toBe(false)
  })

  it("does not take another person's old records", () => {
    const storage = fakeStorage()
    const theirs = `cadence:submissions:things:${stableHash("Solaris", "bruno@example.com")}`
    storage.items.set(theirs, JSON.stringify([{ id: "bruno" }]))
    expect(make(storage).read()).toEqual([])
    expect(storage.items.has(theirs)).toBe(true)
  })
})
