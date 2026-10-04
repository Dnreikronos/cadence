import { describe, expect, it } from "vitest"
import { runRequestSchema } from "@/lib/api/schemas"
import {
  attemptKey,
  buildRunRequest,
  excludedNote,
  fingerprintOf,
  maxRunPayments,
  payLabel,
  runTotal,
  selectRecipients,
  shortfall,
  splitRoster,
  withAmounts,
  type PayrollPerson,
} from "./plan"

const WALLET = "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5"
const guid = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function person(n: number, patch: Partial<PayrollPerson> = {}): PayrollPerson {
  return {
    id: guid(n),
    name: `Person ${n}`,
    email: `p${n}@example.test`,
    kind: "employee",
    activation: "active",
    amount: "1000000",
    ...patch,
  }
}

describe("splitRoster", () => {
  it("pays only activated people who have an amount", () => {
    const people = [
      person(1),
      person(2, { activation: "invited" }),
      person(3, { activation: "invite-expired" }),
      person(4, { activation: "not-invited" }),
      person(5, { amount: null }),
    ]
    const { payable, excluded } = splitRoster(people)
    expect(payable.map((p) => p.id)).toEqual([guid(1)])
    expect(excluded.map((e) => [e.person.id, e.reason])).toEqual([
      [guid(2), "not-activated"],
      [guid(3), "not-activated"],
      [guid(4), "not-activated"],
      [guid(5), "no-amount"],
    ])
  })

  it("says why each person is left out", () => {
    const [invited, expired, fresh, noAmount] = splitRoster([
      person(1, { activation: "invited" }),
      person(2, { activation: "invite-expired" }),
      person(3, { activation: "not-invited" }),
      person(4, { amount: null }),
    ]).excluded
    expect(excludedNote(invited)).toBe("Invite sent, not accepted yet")
    expect(excludedNote(expired)).toBe("Invite expired")
    expect(excludedNote(fresh)).toBe("Hasn't been invited yet")
    expect(excludedNote(noAmount)).toBe("No monthly amount set")
  })

  it("keeps an inactive person out even with no amount", () => {
    const { excluded } = splitRoster([
      person(1, { activation: "invited", amount: null }),
    ])
    expect(excluded[0].reason).toBe("not-activated")
  })
})

describe("withAmounts", () => {
  it("joins by person id and leaves a missing amount null", () => {
    const bare = (n: number) => ({
      id: guid(n),
      name: `Person ${n}`,
      email: `p${n}@example.test`,
      kind: "employee" as const,
      activation: "active" as const,
    })
    const joined = withAmounts(
      [bare(1), bare(2)],
      new Map([[guid(1), "4200000000"]]),
    )
    expect(joined.map((p) => p.amount)).toEqual(["4200000000", null])
  })
})

describe("selection and totals", () => {
  const payable = [
    person(1, { amount: "4200000000" }),
    person(2, { amount: "3800000000" }),
    person(3, { amount: "4300000000" }),
  ]

  it("pays everyone until they are unticked", () => {
    expect(selectRecipients(payable, new Set()).length).toBe(3)
    expect(
      selectRecipients(payable, new Set([guid(2)])).map((p) => p.id),
    ).toEqual([guid(1), guid(3)])
  })

  it("ignores an unticked id that is not payable", () => {
    expect(selectRecipients(payable, new Set([guid(99)])).length).toBe(3)
  })

  it("sums exactly, in base units", () => {
    expect(runTotal(payable)).toBe("12300000000")
    expect(runTotal([])).toBe("0")
    // 0.1 + 0.2 USDC in floats is 0.30000000000000004.
    expect(
      runTotal([
        person(1, { amount: "100000" }),
        person(2, { amount: "200000" }),
      ]),
    ).toBe("300000")
  })

  it("keeps cents of amounts above the float-safe range exact", () => {
    expect(
      runTotal([
        person(1, { amount: "281474976710655" }),
        person(2, { amount: "1" }),
      ]),
    ).toBe("281474976710656")
  })

  it("labels the confirmation with the count and the total", () => {
    expect(payLabel(3, "12300000000")).toBe("Pay 3 people · $12,300.00")
    expect(payLabel(1, "9500000000")).toBe("Pay 1 person · $9,500.00")
  })
})

describe("shortfall", () => {
  it("is null when the balance covers the run, exactly or with room", () => {
    expect(shortfall("1000000", "1000000")).toBeNull()
    expect(shortfall("1000000", "2000000")).toBeNull()
  })

  it("is what is missing, in base units", () => {
    expect(shortfall("12300000000", "10000000000")).toBe("2300000000")
    expect(shortfall("1", "0")).toBe("1")
  })
})

describe("buildRunRequest", () => {
  it("builds a request the contract accepts, in the given order", () => {
    const request = buildRunRequest(
      WALLET,
      [person(2), person(1)],
      "d0000000-0000-4000-8000-000000000009",
    )
    expect(runRequestSchema.safeParse(request).success).toBe(true)
    expect(request.payments.map((p) => p.person_id)).toEqual([guid(2), guid(1)])
    expect(request.idempotency_key).toBe("d0000000-0000-4000-8000-000000000009")
  })

  it("accepts a single recipient, the supplier case", () => {
    const request = buildRunRequest(
      WALLET,
      [person(4, { kind: "supplier", amount: "9500000000" })],
      "d0000000-0000-4000-8000-000000000009",
    )
    expect(request.payments).toEqual([
      { person_id: guid(4), amount: "9500000000" },
    ])
  })

  it("refuses an empty run and one past the service's limit", () => {
    const key = "d0000000-0000-4000-8000-000000000009"
    expect(() => buildRunRequest(WALLET, [], key)).toThrow()
    const many = Array.from({ length: maxRunPayments + 1 }, (_, i) =>
      person(i + 1),
    )
    expect(() => buildRunRequest(WALLET, many, key)).toThrow()
    expect(() =>
      buildRunRequest(WALLET, many.slice(0, maxRunPayments), key),
    ).not.toThrow()
  })

  it("refuses a person with no amount", () => {
    expect(() =>
      buildRunRequest(
        WALLET,
        [person(1, { amount: null })],
        "d0000000-0000-4000-8000-000000000009",
      ),
    ).toThrow()
  })
})

describe("attemptKey", () => {
  let made = 0
  const make = () => `key-${++made}`

  it("keeps the key while the payment list is the same, so a double click makes one run", () => {
    const list = [person(1), person(2)]
    const first = attemptKey(null, fingerprintOf(WALLET, list), make)
    const again = attemptKey(first, fingerprintOf(WALLET, [...list]), make)
    expect(again).toBe(first)
    expect(made).toBe(1)
  })

  it("makes a new key when someone is ticked or unticked", () => {
    const first = attemptKey(
      null,
      fingerprintOf(WALLET, [person(1), person(2)]),
      make,
    )
    const next = attemptKey(first, fingerprintOf(WALLET, [person(1)]), make)
    expect(next.key).not.toBe(first.key)
  })

  it("makes a new key when an amount changes", () => {
    const first = attemptKey(
      null,
      fingerprintOf(WALLET, [person(1, { amount: "1000000" })]),
      make,
    )
    const next = attemptKey(
      first,
      fingerprintOf(WALLET, [person(1, { amount: "2000000" })]),
      make,
    )
    expect(next.key).not.toBe(first.key)
  })
})
