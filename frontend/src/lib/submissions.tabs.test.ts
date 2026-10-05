import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { browserProfile } from "./browser-profile"
import {
  clearSettledEvidence,
  finishLeaving,
  markLeaving,
  createRecordList,
  evidenceMaxAgeMs,
  legacyViewerScopeIds,
  pruneEvidence,
  readSubmission,
  recordSubmission,
  submissionStore,
  viewerScopeId,
  type SubmissionStorage,
} from "./submissions"

const bruno = { company: "Solaris", email: "bruno@solaris.test" }
const ana = { company: "Solaris", email: "ana@solaris.test" }

const held = z.object({
  amount_units: z.string(),
  at: z.number(),
})
type Held = z.infer<typeof held>

function heldList(storage: SubmissionStorage, viewer = bruno) {
  return createRecordList<Held>({
    kind: "withdraw",
    scope: viewerScopeId(viewer),
    schema: held,
    same: (a, b) => a.amount_units === b.amount_units,
    storage,
  })
}

const submission = {
  kind: "wrap",
  request_id: "a".repeat(64),
  signature: null,
  last_valid_block_height: 1234,
  wallet: "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5",
  at: 1_000,
}

describe("a list of records shared by two tabs", () => {
  it("shows the second tab what the first one saved, without being told", () => {
    const shared = browserProfile()
    const a = heldList(shared.tab())
    const b = heldList(shared.tab())
    expect(b.read()).toEqual([])

    a.upsert({ amount_units: "1234560000", at: 5 })

    expect(b.read()).toEqual([{ amount_units: "1234560000", at: 5 }])
  })

  it("shows it what the first one released, so the amount is free again", () => {
    const shared = browserProfile()
    const a = heldList(shared.tab())
    const b = heldList(shared.tab())
    a.upsert({ amount_units: "5", at: 1 })
    expect(b.read()).toHaveLength(1)

    a.remove((record) => record.amount_units === "5")

    expect(b.read()).toEqual([])
  })

  it("gives the same array until something changes, so a React store can read it each render", () => {
    const shared = browserProfile()
    const a = heldList(shared.tab())
    const b = heldList(shared.tab())
    a.upsert({ amount_units: "5", at: 1 })
    const first = b.read()
    expect(b.read()).toBe(first)
    expect(b.read()).toBe(first)

    a.upsert({ amount_units: "6", at: 2 })
    const second = b.read()
    expect(second).not.toBe(first)
    expect(b.read()).toBe(second)
  })

  it("does not erase the other tab's record when it writes its own", () => {
    const shared = browserProfile()
    const a = heldList(shared.tab())
    const b = heldList(shared.tab())
    // Both read the empty list first, as two screens that had just opened.
    expect(a.read()).toEqual([])
    expect(b.read()).toEqual([])

    a.upsert({ amount_units: "1", at: 1 })
    b.upsert({ amount_units: "2", at: 2 })

    expect(a.read().map((r) => r.amount_units)).toEqual(["1", "2"])
    expect(b.read().map((r) => r.amount_units)).toEqual(["1", "2"])
  })

  it("tells a subscribed tab when another changes its key, and only then", () => {
    const shared = browserProfile()
    const a = heldList(shared.tab())
    const bStorage = shared.tab()
    const b = heldList(bStorage)
    const heard = vi.fn()
    const stop = b.subscribe(heard)

    a.upsert({ amount_units: "1", at: 1 })
    expect(heard).toHaveBeenCalledTimes(1)

    // Another viewer's list, and unrelated keys, are not this list's business.
    heldList(shared.tab(), ana).upsert({ amount_units: "9", at: 1 })
    shared.tab().setItem("something:else", "x")
    expect(heard).toHaveBeenCalledTimes(1)

    // The whole store cleared.
    shared.wipe()
    expect(heard).toHaveBeenCalledTimes(2)
    expect(b.read()).toEqual([])

    stop()
    a.upsert({ amount_units: "2", at: 2 })
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it("is told of the tab's own writes too, as before", () => {
    const shared = browserProfile()
    const a = heldList(shared.tab())
    const heard = vi.fn()
    a.subscribe(heard)
    a.upsert({ amount_units: "1", at: 1 })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it("keeps a viewer's records away from another's", () => {
    const shared = browserProfile()
    heldList(shared.tab(), bruno).upsert({ amount_units: "1", at: 1 })
    expect(heldList(shared.tab(), ana).read()).toEqual([])
    expect(heldList(shared.tab(), bruno).read()).toHaveLength(1)
  })

  it("sees saved state another tab could not read as unreadable, and its release", () => {
    const shared = browserProfile()
    const key = `cadence:submissions:withdraw:${viewerScopeId(bruno)}`
    shared.items.set(key, JSON.stringify([{ amount_units: 5 }]))
    const a = heldList(shared.tab())
    const b = heldList(shared.tab())
    expect(a.unreadable()).toBe(true)
    // The second tab finds what the first set aside: the whole list is held there too.
    expect(b.unreadable()).toBe(true)

    b.clearUnreadable()

    expect(a.unreadable()).toBe(false)
    expect(b.unreadable()).toBe(false)
  })

  it("tells a subscribed tab when another releases what could not be read", () => {
    const shared = browserProfile()
    const key = `cadence:submissions:withdraw:${viewerScopeId(bruno)}`
    shared.items.set(key, "not json")
    const a = heldList(shared.tab())
    const b = heldList(shared.tab())
    expect(a.unreadable()).toBe(true)
    const heard = vi.fn()
    a.subscribe(heard)

    b.clearUnreadable()

    expect(heard).toHaveBeenCalled()
    expect(a.unreadable()).toBe(false)
  })

  it("keeps what it holds in memory when storage refuses, and takes the other tab's changes when it can read again", () => {
    const shared = browserProfile()
    const good = shared.tab()
    let refuse = true
    const flaky: SubmissionStorage = {
      ...good,
      setItem: (key, value) => {
        if (refuse) throw new DOMException("QuotaExceededError")
        good.setItem(key, value)
      },
    }
    const a = heldList(flaky)
    expect(a.upsert({ amount_units: "1", at: 1 })).toBe(false)
    expect(a.read()).toEqual([{ amount_units: "1", at: 1 }])

    refuse = false
    heldList(shared.tab()).upsert({ amount_units: "2", at: 2 })
    expect(a.read().map((r) => r.amount_units)).toEqual(["2"])
  })
})

describe("a single record kept per viewer", () => {
  it("is read by every tab of the viewer, and by no other viewer", () => {
    const shared = browserProfile()
    const a = submissionStore("wrap", bruno, shared.tab())
    const b = submissionStore("wrap", bruno, shared.tab())
    const other = submissionStore("wrap", ana, shared.tab())
    expect(b.read()).toBeNull()

    a.record(submission)

    expect(b.read()).toEqual(submission)
    expect(other.read()).toBeNull()
    // The key names the viewer by a hash, never by an email.
    expect([...shared.items.keys()]).toEqual([
      `cadence:submission:wrap:${viewerScopeId(bruno)}`,
    ])
  })

  it("is cleared for every tab, and only for its viewer", () => {
    const shared = browserProfile()
    const a = submissionStore("wrap", bruno, shared.tab())
    const b = submissionStore("wrap", bruno, shared.tab())
    const other = submissionStore("wrap", ana, shared.tab())
    a.record(submission)
    other.record(submission)

    b.clear()

    expect(a.read()).toBeNull()
    expect(other.read()).toEqual(submission)
  })

  it("keeps a kind apart from another kind", () => {
    const shared = browserProfile()
    submissionStore("wrap", bruno, shared.tab()).record(submission)
    expect(submissionStore("apply-pending", bruno, shared.tab()).read()).toBe(
      null,
    )
  })

  it("tells a subscribed tab when another saves or clears it, and its version changes", () => {
    const shared = browserProfile()
    const a = submissionStore("wrap", bruno, shared.tab())
    const b = submissionStore("wrap", bruno, shared.tab())
    const heard = vi.fn()
    b.subscribe(heard)
    const empty = b.version()

    a.record(submission)
    expect(heard).toHaveBeenCalledTimes(1)
    const saved = b.version()
    expect(saved).not.toBe(empty)
    expect(b.version()).toBe(saved)

    a.clear()
    expect(heard).toHaveBeenCalledTimes(2)
    expect(b.version()).toBe(empty)
  })

  it("still reads a record written the old way, with no viewer, under its own key", () => {
    const storage = browserProfile().tab()
    recordSubmission(submission, storage)
    expect(readSubmission("wrap", storage)).toEqual(submission)
    expect(readSubmission("wrap", storage, viewerScopeId(bruno))).toBeNull()
  })

  it("works with no storage at all", () => {
    const store = submissionStore("wrap", bruno, null)
    expect(store.read()).toBeNull()
    expect(() => store.clear()).not.toThrow()
    expect(store.version()).toBeNull()
    expect(() => store.subscribe(() => {})()).not.toThrow()
  })
})

describe("clearSettledEvidence", () => {
  const scope = (viewer: typeof bruno) => viewerScopeId(viewer)
  const seed = (shared: ReturnType<typeof browserProfile>) => {
    const tab = shared.tab()
    for (const viewer of [bruno, ana]) {
      const id = scope(viewer)
      tab.setItem(
        `cadence:submission:wrap:${id}`,
        JSON.stringify({ ...submission, at: 5 }),
      )
      tab.setItem(
        `cadence:submission:apply-pending:${id}`,
        JSON.stringify({ ...submission, kind: "apply-pending", at: 5 }),
      )
      tab.setItem(
        `cadence:submissions:withdraw:${id}`,
        JSON.stringify([{ amount_units: "5", at: 5 }]),
      )
      tab.setItem(`cadence:submissions:withdraw:${id}:unreadable`, "[1]")
      tab.setItem(
        `cadence:submissions:payroll-payment:${id}`,
        JSON.stringify([{ payment_id: "p1", run_id: "open", at: 5 }]),
      )
      tab.setItem(
        `cadence:submissions:payroll-attempt:${id}`,
        JSON.stringify([
          // Its run has a payment in doubt, one has no run yet (the answer may be lost),
          // and one is settled.
          { fingerprint: "a", run_id: "open", created_at: 5 },
          { fingerprint: "b", created_at: 5 },
          { fingerprint: "c", run_id: "done", created_at: 5 },
        ]),
      )
    }
    tab.setItem("cadence:probe", "x")
    tab.setItem("other:key", "x")
    return tab
  }

  it("keeps what may have been sent: the same person signing back in finds it held", () => {
    const shared = browserProfile()
    const tab = seed(shared)

    clearSettledEvidence(bruno, tab)

    const id = scope(bruno)
    for (const key of [
      `cadence:submission:wrap:${id}`,
      `cadence:submission:apply-pending:${id}`,
      `cadence:submissions:withdraw:${id}`,
      `cadence:submissions:payroll-payment:${id}`,
    ]) {
      expect(shared.items.has(key), key).toBe(true)
    }
    // The withdrawal is still held, in the list a tab reads.
    expect(heldList(shared.tab()).read()).toEqual([
      { amount_units: "5", at: 5 },
    ])
  })

  it("removes only what is settled: unreadable leftovers and attempts with nothing in doubt", () => {
    const shared = browserProfile()
    const tab = seed(shared)

    clearSettledEvidence(bruno, tab)

    const id = scope(bruno)
    expect(
      shared.items.has(`cadence:submissions:withdraw:${id}:unreadable`),
    ).toBe(false)
    expect(
      JSON.parse(
        shared.items.get(`cadence:submissions:payroll-attempt:${id}`)!,
      ),
    ).toEqual([
      { fingerprint: "a", run_id: "open", created_at: 5 },
      { fingerprint: "b", created_at: 5 },
    ])
  })

  it("removes an attempt list that is left empty, and touches nobody else's", () => {
    const shared = browserProfile()
    const tab = shared.tab()
    const id = scope(bruno)
    tab.setItem(
      `cadence:submissions:payroll-attempt:${id}`,
      JSON.stringify([{ fingerprint: "c", run_id: "done", created_at: 5 }]),
    )
    const full = seed(browserProfile())
    clearSettledEvidence(bruno, tab)
    expect(shared.items.size).toBe(0)

    // Another viewer's records, settled or not, are left as they are.
    const other = browserProfile()
    const otherTab = seed(other)
    const before = new Map(other.items)
    clearSettledEvidence(bruno, otherTab)
    for (const [key, value] of before) {
      if (key.includes(scope(ana)) || !key.includes(scope(bruno))) {
        expect(other.items.get(key), key).toBe(value)
      }
    }
    expect(full).toBeDefined()
  })

  it("never lets one viewer's records block or show to another", () => {
    const shared = browserProfile()
    seed(shared)
    clearSettledEvidence(ana, shared.tab())
    expect(heldList(shared.tab(), bruno).read()).toHaveLength(1)
    expect(submissionStore("wrap", ana, shared.tab()).read()).not.toBeNull()
    // A viewer with nothing saved finds nothing, whoever else has.
    const carla = { company: "Acme", email: "carla@acme.test" }
    expect(heldList(shared.tab(), carla).read()).toEqual([])
    expect(submissionStore("wrap", carla, shared.tab()).read()).toBeNull()
  })

  it("also reads records an earlier version saved under the company name", () => {
    const shared = browserProfile()
    const tab = shared.tab()
    const withId = { ...bruno, companyId: "c-1" }
    const legacy = legacyViewerScopeIds(withId)[0]!
    tab.setItem(`cadence:submissions:withdraw:${legacy}:unreadable`, "[1]")
    clearSettledEvidence(withId, tab)
    expect(shared.items.size).toBe(0)
  })

  it("does nothing, and does not throw, without storage or with storage that cannot list", () => {
    expect(() => clearSettledEvidence(bruno, null)).not.toThrow()
    const blind: SubmissionStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }
    expect(() => clearSettledEvidence(bruno, blind)).not.toThrow()
    expect(() =>
      clearSettledEvidence(bruno, {
        ...blind,
        keys: () => {
          throw new Error("blocked")
        },
      }),
    ).not.toThrow()
  })
})

describe("leaving", () => {
  const marker = () => {
    const items = new Map<string, string>()
    return {
      items,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    }
  }

  it("clears what is settled only once the sign-in page is reached, not when sign-out is pressed", () => {
    const shared = browserProfile()
    const tab = shared.tab()
    tab.setItem(
      `cadence:submissions:withdraw:${viewerScopeId(bruno)}:unreadable`,
      "[1]",
    )
    const note = marker()

    markLeaving(bruno, note)
    // The sign-out request failed: the page is still signed in, and nothing was removed.
    expect(shared.items.size).toBe(1)

    finishLeaving(tab, note)
    expect(shared.items.size).toBe(0)
    expect(note.items.size).toBe(0)
  })

  it("keeps what is held, and does nothing when nobody was noted", () => {
    const shared = browserProfile()
    const tab = shared.tab()
    heldList(tab).upsert({ amount_units: "5", at: 1 })
    const note = marker()

    finishLeaving(tab, note)
    markLeaving(bruno, note)
    finishLeaving(tab, note)

    expect(heldList(shared.tab()).read()).toHaveLength(1)
  })

  it("ignores a note it cannot read, and a missing or refusing marker", () => {
    const shared = browserProfile()
    const note = marker()
    note.items.set("cadence:leaving", "not json")
    expect(() => finishLeaving(shared.tab(), note)).not.toThrow()
    expect(() => finishLeaving(shared.tab(), null)).not.toThrow()
    expect(() => markLeaving(bruno, null)).not.toThrow()
    expect(() =>
      markLeaving(bruno, {
        setItem: () => {
          throw new Error("blocked")
        },
      }),
    ).not.toThrow()
  })
})

describe("a write that races another tab's", () => {
  // A tab whose storage lets another tab write right after it reads the key once: the
  // moment between this tab reading and writing, which only a lock could close.
  function racing() {
    const shared = browserProfile()
    const other = heldList(shared.tab())
    const tab = shared.tab()
    let fire: (() => void) | null = null
    const key = `cadence:submissions:withdraw:${viewerScopeId(bruno)}`
    const ours = {
      ...tab,
      getItem: (name: string) => {
        const value = tab.getItem(name)
        if (name === key && fire) {
          const run = fire
          fire = null
          run()
        }
        return value
      },
    }
    return {
      shared,
      other,
      ours: heldList(ours),
      race: (run: () => void) => {
        fire = run
      },
    }
  }

  it("does not lose the other tab's record when it adds its own", () => {
    const { ours, other, race } = racing()
    expect(ours.read()).toEqual([])
    race(() => other.upsert({ amount_units: "2", at: 2 }))

    ours.upsert({ amount_units: "1", at: 1 })

    expect(
      ours
        .read()
        .map((r) => r.amount_units)
        .sort(),
    ).toEqual(["1", "2"])
    expect(
      other
        .read()
        .map((r) => r.amount_units)
        .sort(),
    ).toEqual(["1", "2"])
  })

  it("does not bring back what the other tab removed, nor lose what it added, when it removes", () => {
    const { ours, other, race } = racing()
    ours.upsert({ amount_units: "1", at: 1 })
    expect(other.read()).toHaveLength(1)
    race(() => {
      other.remove((r) => r.amount_units === "1")
      other.upsert({ amount_units: "3", at: 3 })
    })

    ours.remove((r) => r.amount_units === "1")

    expect(ours.read().map((r) => r.amount_units)).toEqual(["3"])
    expect(other.read().map((r) => r.amount_units)).toEqual(["3"])
  })

  it("prunes on what is stored now, not on what it read", () => {
    const shared = browserProfile()
    const tab = shared.tab()
    const key = `cadence:submissions:withdraw:${viewerScopeId(bruno)}`
    tab.setItem(key, JSON.stringify([{ amount_units: "1", at: 0 }]))
    let fired = false
    const racing: SubmissionStorage = {
      ...tab,
      getItem: (name) => {
        const value = tab.getItem(name)
        if (name === key && !fired) {
          fired = true
          // Another tab adds a fresh record after this read.
          shared.tab().setItem(
            key,
            JSON.stringify([
              { amount_units: "1", at: 0 },
              { amount_units: "2", at: 10_000_000_000 },
            ]),
          )
        }
        return value
      },
    }

    expect(pruneEvidence(10_000_000_000, racing)).toBe(1)

    expect(JSON.parse(tab.getItem(key)!)).toEqual([
      { amount_units: "2", at: 10_000_000_000 },
    ])
  })
})

describe("pruneEvidence", () => {
  const day = 24 * 60 * 60 * 1000
  const now = 100 * day

  it("removes records older than the limit and keeps the rest", () => {
    const shared = browserProfile()
    const tab = shared.tab()
    const scope = viewerScopeId(bruno)
    tab.setItem(
      `cadence:submissions:withdraw:${scope}`,
      JSON.stringify([
        { amount_units: "1", at: now - evidenceMaxAgeMs - 1 },
        { amount_units: "2", at: now - 1_000 },
      ]),
    )
    tab.setItem(
      `cadence:submissions:payroll-attempt:${scope}`,
      JSON.stringify([
        { fingerprint: "f", created_at: now - evidenceMaxAgeMs - 5 },
      ]),
    )
    tab.setItem(
      `cadence:submission:wrap:${scope}`,
      JSON.stringify({ ...submission, at: now - evidenceMaxAgeMs - 1 }),
    )
    tab.setItem(
      `cadence:submission:apply-pending:${scope}`,
      JSON.stringify({ ...submission, at: now }),
    )

    expect(pruneEvidence(now, tab)).toBe(3)

    expect(
      JSON.parse(tab.getItem(`cadence:submissions:withdraw:${scope}`)!),
    ).toEqual([{ amount_units: "2", at: now - 1_000 }])
    // A list left with nothing is removed, not kept empty.
    expect(tab.getItem(`cadence:submissions:payroll-attempt:${scope}`)).toBe(
      null,
    )
    expect(tab.getItem(`cadence:submission:wrap:${scope}`)).toBeNull()
    expect(tab.getItem(`cadence:submission:apply-pending:${scope}`)).not.toBe(
      null,
    )
  })

  it("keeps a record exactly at the limit, and honours another limit", () => {
    const tab = browserProfile().tab()
    const scope = viewerScopeId(bruno)
    const key = `cadence:submission:wrap:${scope}`
    tab.setItem(key, JSON.stringify({ ...submission, at: now - 10 }))
    expect(pruneEvidence(now, tab, 10)).toBe(0)
    expect(pruneEvidence(now, tab, 9)).toBe(1)
  })

  it("leaves alone what it cannot read or date, and the set-aside unreadable entries", () => {
    const tab = browserProfile().tab()
    const scope = viewerScopeId(bruno)
    const keep = {
      [`cadence:submissions:withdraw:${scope}`]: "not json",
      [`cadence:submissions:payroll-payment:${scope}`]: JSON.stringify([
        { payment_id: "no time" },
        "a string",
        null,
      ]),
      [`cadence:submissions:withdraw:${scope}:unreadable`]: JSON.stringify([
        { amount_units: 1, at: 0 },
      ]),
      "cadence:probe": "x",
      "cadence:submissions:withdraw:nothex": JSON.stringify([{ at: 0 }]),
    }
    for (const [key, value] of Object.entries(keep)) tab.setItem(key, value)

    expect(pruneEvidence(now, tab)).toBe(0)

    for (const [key, value] of Object.entries(keep)) {
      expect(tab.getItem(key)).toBe(value)
    }
  })

  it("prunes every viewer's records, not only the one signed in", () => {
    const tab = browserProfile().tab()
    for (const viewer of [bruno, ana]) {
      tab.setItem(
        `cadence:submission:wrap:${viewerScopeId(viewer)}`,
        JSON.stringify({ ...submission, at: 0 }),
      )
    }
    expect(pruneEvidence(now, tab)).toBe(2)
  })

  it("does nothing, and does not throw, without storage or with a store that cannot be listed", () => {
    expect(pruneEvidence(now, null)).toBe(0)
    const blind: SubmissionStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }
    expect(pruneEvidence(now, blind)).toBe(0)
    expect(
      pruneEvidence(now, {
        ...blind,
        keys: () => {
          throw new Error("blocked")
        },
      }),
    ).toBe(0)
  })

  it("is a month by default", () => {
    expect(evidenceMaxAgeMs).toBe(30 * day)
  })
})

// The page's own `localStorage`, which is where the app's records live.
describe("the browser's localStorage", () => {
  afterEach(() => vi.unstubAllGlobals())

  function fakeWindow() {
    const items = new Map<string, string>()
    const listeners = new Set<(event: StorageEvent) => void>()
    const localStorage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
      key: (index: number) => [...items.keys()][index] ?? null,
      get length() {
        return items.size
      },
    }
    const win = {
      localStorage,
      addEventListener: (type: string, listener: (e: StorageEvent) => void) => {
        if (type === "storage") listeners.add(listener)
      },
      removeEventListener: (
        type: string,
        listener: (e: StorageEvent) => void,
      ) => {
        if (type === "storage") listeners.delete(listener)
      },
    }
    return {
      win,
      items,
      listeners,
      // What another tab's write looks like to this one.
      fire: (key: string | null, area: unknown = localStorage) =>
        listeners.forEach((l) =>
          l({ key, storageArea: area } as unknown as StorageEvent),
        ),
    }
  }

  it("keeps records in localStorage, not sessionStorage, where another tab can read them", () => {
    const { win, items } = fakeWindow()
    vi.stubGlobal("window", { ...win, sessionStorage: undefined })

    recordSubmission(submission)

    expect([...items.keys()]).toEqual(["cadence:submission:wrap"])
    expect(readSubmission("wrap")).toEqual(submission)
  })

  it("lists its keys, and tells a subscriber of other tabs' writes to the records it watches", () => {
    const { win, items, listeners, fire } = fakeWindow()
    vi.stubGlobal("window", win)
    const store = submissionStore("wrap", bruno)
    const heard = vi.fn()
    const stop = store.subscribe(heard)
    expect(listeners.size).toBe(1)

    items.set(`cadence:submission:wrap:${viewerScopeId(bruno)}`, "{}")
    fire(`cadence:submission:wrap:${viewerScopeId(bruno)}`)
    expect(heard).toHaveBeenCalledTimes(1)
    // Another key, and another storage area (sessionStorage), are not it.
    fire("something:else")
    fire(`cadence:submission:wrap:${viewerScopeId(bruno)}`, {})
    expect(heard).toHaveBeenCalledTimes(1)
    // `clear()` in another tab has no key.
    fire(null)
    expect(heard).toHaveBeenCalledTimes(2)

    // It lists the browser's keys: a settled leftover goes, a record held stays.
    items.set(
      `cadence:submissions:withdraw:${viewerScopeId(bruno)}:unreadable`,
      "[1]",
    )
    clearSettledEvidence(bruno)
    expect([...items.keys()]).toEqual([
      `cadence:submission:wrap:${viewerScopeId(bruno)}`,
    ])

    stop()
    expect(listeners.size).toBe(0)
  })

  it("has no storage where there is no window, or where reading it throws", () => {
    expect(readSubmission("wrap")).toBeNull()
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new DOMException("blocked", "SecurityError")
      },
    })
    expect(readSubmission("wrap")).toBeNull()
    expect(() => recordSubmission(submission)).not.toThrow()
  })
})
