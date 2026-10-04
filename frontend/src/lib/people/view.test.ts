import { describe, expect, it } from "vitest"
import { withAmount } from "./amounts"
import type { PersonRecord } from "./types"
import { amountsView, currentAmount, hasActiveAuditor, summarize } from "./view"

const person = (id: string): PersonRecord => ({
  id,
  name: id,
  email: `${id}@solaris.test`,
  kind: "employee",
  activation: "active",
})
const people = ["a", "b", "c"].map(person)

const read = (byPerson: Record<string, string>, truncated = false) => ({
  byPerson,
  truncated,
})

describe("amountsView", () => {
  it("is loading before the first answer and error when it fails", () => {
    expect(amountsView({ data: undefined, isError: false })).toEqual({
      state: "loading",
    })
    expect(amountsView({ data: undefined, isError: true })).toEqual({
      state: "error",
    })
  })

  it("is ready with the amounts read", () => {
    expect(amountsView({ data: read({ a: "1" }), isError: false })).toEqual({
      state: "ready",
      byPerson: { a: "1" },
      truncated: false,
    })
  })

  it("keeps the old figures but calls them stale when a refresh failed", () => {
    expect(amountsView({ data: read({ a: "1" }), isError: true })).toEqual({
      state: "stale",
      byPerson: { a: "1" },
      truncated: false,
    })
  })
})

describe("summarize", () => {
  const ready = amountsView({
    data: read({ a: "4200000000", b: "3800000000" }),
    isError: false,
  })

  it("totals the amounts of the people shown, exactly", () => {
    expect(summarize(people, ready)).toEqual({
      total: "8000000000",
      missing: 1,
    })
  })

  it("ignores an amount whose person is not shown", () => {
    const view = amountsView({
      data: read({ a: "1000000", gone: "9000000000" }),
      isError: false,
    })
    expect(summarize([person("a")], view).total).toBe("1000000")
  })

  it("counts nobody as missing when the read was partial", () => {
    const view = amountsView({ data: read({ a: "1" }, true), isError: false })
    expect(summarize(people, view)).toEqual({ total: "1", missing: 0 })
  })

  it("has no total until the amounts are read, and none when they failed", () => {
    for (const data of [undefined]) {
      for (const isError of [false, true]) {
        expect(summarize(people, amountsView({ data, isError }))).toEqual({
          total: undefined,
          missing: 0,
        })
      }
    }
  })

  it("still totals stale figures, which the screen warns about", () => {
    const stale = amountsView({ data: read({ a: "5" }), isError: true })
    expect(summarize(people, stale).total).toBe("5")
  })

  it("is zero for an empty list", () => {
    expect(summarize([], ready)).toEqual({ total: "0", missing: 0 })
  })
})

describe("currentAmount", () => {
  const ready = amountsView({ data: read({ a: "5000000000" }), isError: false })

  it("knows the amount when the figures are fresh", () => {
    expect(currentAmount(ready, false, "a")).toEqual({
      known: true,
      units: "5000000000",
    })
    expect(currentAmount(ready, false, "b")).toEqual({
      known: true,
      units: undefined,
    })
  })

  // The scenario: 4000 became 5000, the refresh failed, the row still said 4000.
  // Typing 4000 to undo it must reach the service, so the form must not trust
  // the figure it holds.
  it("does not know the amount when a refresh failed", () => {
    const stale = amountsView({
      data: read({ a: "4000000000" }),
      isError: true,
    })
    expect(currentAmount(stale, false, "a")).toEqual({ known: false })
  })

  it("does not know the amount while a refresh is running", () => {
    expect(currentAmount(ready, true, "a")).toEqual({ known: false })
  })

  it("does not know the amount while loading or after a failed first load", () => {
    expect(currentAmount({ state: "loading" }, false, "a")).toEqual({
      known: false,
    })
    expect(currentAmount({ state: "error" }, false, "a")).toEqual({
      known: false,
    })
  })

  it("cannot say a person has none when the read was partial", () => {
    const partial = amountsView({
      data: read({ a: "1" }, true),
      isError: false,
    })
    expect(currentAmount(partial, false, "zzz")).toEqual({ known: false })
    expect(currentAmount(partial, false, "a")).toEqual({
      known: true,
      units: "1",
    })
  })
})

describe("withAmount", () => {
  it("replaces one person's amount and keeps the rest", () => {
    const next = withAmount(read({ a: "1", b: "2" }, true), "a", "9")
    expect(next).toEqual({ byPerson: { a: "9", b: "2" }, truncated: true })
  })

  it("adds an amount for a person that had none", () => {
    expect(withAmount(read({}), "a", "9")?.byPerson).toEqual({ a: "9" })
  })

  it("does not invent a read that was never made", () => {
    expect(withAmount(undefined, "a", "9")).toBeUndefined()
  })

  it("does not change the read it was given", () => {
    const original = read({ a: "1" })
    withAmount(original, "a", "9")
    expect(original.byPerson.a).toBe("1")
  })
})

describe("hasActiveAuditor", () => {
  const rows = (...statuses: string[]) => statuses.map((status) => ({ status }))

  it("is true with an active auditor, even in a partial list", () => {
    expect(
      hasActiveAuditor({ rows: rows("invited", "active"), truncated: true }),
    ).toBe(true)
  })

  it("is false when the whole list has no active auditor", () => {
    expect(
      hasActiveAuditor({
        rows: rows("invited", "invite-expired"),
        truncated: false,
      }),
    ).toBe(false)
    expect(hasActiveAuditor({ rows: [], truncated: false })).toBe(false)
  })

  it("is unknown while loading or failed, and for a partial list without one", () => {
    expect(hasActiveAuditor(undefined)).toBeUndefined()
    expect(
      hasActiveAuditor({ rows: rows("invited"), truncated: true }),
    ).toBeUndefined()
  })
})
