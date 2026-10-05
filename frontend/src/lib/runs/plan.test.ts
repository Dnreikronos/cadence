import { describe, expect, it } from "vitest"
import { runRequestSchema } from "@/lib/api/schemas"
import {
  allChoices,
  attemptKey,
  buildRunRequest,
  createdMatches,
  excludedNote,
  fingerprintOf,
  formatExact,
  holdChecking,
  isTicked,
  maxRunPayments,
  payLabel,
  recentWindowMs,
  recentlyPaidIds,
  repaid,
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

  const nobody = new Set<string>()

  it("pays everyone until they are unticked", () => {
    expect(selectRecipients(payable, nobody, {}).length).toBe(3)
    expect(
      selectRecipients(payable, nobody, { [guid(2)]: false }).map((p) => p.id),
    ).toEqual([guid(1), guid(3)])
  })

  it("ignores a choice about someone who is not payable", () => {
    expect(
      selectRecipients(payable, nobody, { [guid(99)]: false }).length,
    ).toBe(3)
  })

  it("does not tick someone paid recently, until they are ticked by hand", () => {
    const recent = new Set([guid(1)])
    expect(selectRecipients(payable, recent, {}).map((p) => p.id)).toEqual([
      guid(2),
      guid(3),
    ])
    expect(
      selectRecipients(payable, recent, { [guid(1)]: true }).map((p) => p.id),
    ).toEqual([guid(1), guid(2), guid(3)])
    expect(isTicked(guid(1), recent, { [guid(1)]: false })).toBe(false)
  })

  it("names who is ticked despite a recent payment", () => {
    const recent = new Set([guid(1), guid(3)])
    const recipients = selectRecipients(payable, recent, { [guid(1)]: true })
    expect(repaid(recipients, recent).map((p) => p.id)).toEqual([guid(1)])
    expect(repaid(selectRecipients(payable, recent, {}), recent)).toEqual([])
  })

  it("selects everyone except the recently paid, and clears to nobody", () => {
    const recent = new Set([guid(2)])
    const all = allChoices(payable, recent, true)
    expect(selectRecipients(payable, recent, all).map((p) => p.id)).toEqual([
      guid(1),
      guid(3),
    ])
    const none = allChoices(payable, recent, false)
    expect(selectRecipients(payable, recent, none)).toEqual([])
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

describe("recentlyPaidIds", () => {
  const now = Date.parse("2026-10-04T12:00:00Z")
  const payment = (
    counterparty: number,
    status: "pending" | "confirmed" | "failed",
    hoursAgo: number,
  ) => ({
    status,
    paid_at: new Date(now - hoursAgo * 3_600_000).toISOString(),
    counterparty: { id: guid(counterparty), name: `Person ${counterparty}` },
  })

  it("takes confirmed payments inside the window, by the counterparty's id", () => {
    const ids = recentlyPaidIds(
      [payment(1, "confirmed", 1), payment(2, "confirmed", 23.9)],
      now,
    )
    expect([...ids].sort()).toEqual([guid(1), guid(2)])
  })

  it("leaves out older payments, and ones that did not land", () => {
    const ids = recentlyPaidIds(
      [
        payment(1, "confirmed", 24.1),
        payment(2, "failed", 1),
        payment(3, "pending", 1),
        payment(4, "confirmed", 24 * 30),
      ],
      now,
    )
    expect(ids.size).toBe(0)
  })

  it("counts the person once however many payments they got", () => {
    const ids = recentlyPaidIds(
      [payment(1, "confirmed", 1), payment(1, "confirmed", 2)],
      now,
    )
    expect(ids.size).toBe(1)
  })

  it("holds the window to 24 hours, to the millisecond", () => {
    const at = (offset: number) => ({
      status: "confirmed" as const,
      paid_at: new Date(now - recentWindowMs + offset).toISOString(),
      counterparty: { id: guid(1), name: "x" },
    })
    expect(recentlyPaidIds([at(0)], now).size).toBe(1)
    expect(recentlyPaidIds([at(-1)], now).size).toBe(0)
  })

  it("ignores a payment whose date it cannot read", () => {
    expect(
      recentlyPaidIds(
        [
          {
            status: "confirmed",
            paid_at: "not a date",
            counterparty: { id: guid(1), name: "x" },
          },
        ],
        now,
      ).size,
    ).toBe(0)
  })
})

describe("formatExact", () => {
  it("shows whole cents as dollars", () => {
    expect(formatExact("12300000000")).toBe("$12,300.00")
    expect(formatExact("10000")).toBe("$0.01")
  })

  it("shows anything finer than a cent in full instead of rounding it away", () => {
    expect(formatExact("10001")).toBe("0.010001 USDC")
    expect(formatExact("1")).toBe("0.000001 USDC")
  })
})

describe("createdMatches", () => {
  const request = (...people: number[]) =>
    buildRunRequest(
      WALLET,
      people.map((n) => person(n)),
      "d0000000-0000-4000-8000-000000000009",
    )
  const created = (people: number[], paymentIds = people) => ({
    run_id: "c0000000-0000-4000-8000-000000000001",
    payments: people.map((n, i) => ({
      payment_id: guid(500 + paymentIds[i]),
      person_id: guid(n),
      request_id: "a".repeat(64),
      transaction: "AQID",
      transaction_version: 1 as const,
      required_signers: ["w"],
      recent_blockhash: "h",
      last_valid_block_height: 1,
    })),
  })

  it("accepts the same people, in any order", () => {
    expect(createdMatches(request(1, 2, 3), created([3, 1, 2]))).toBe(true)
  })

  it("refuses a different person, a missing one, an extra one and a duplicate", () => {
    expect(createdMatches(request(1, 2), created([1, 9]))).toBe(false)
    expect(createdMatches(request(1, 2), created([1]))).toBe(false)
    expect(createdMatches(request(1, 2), created([1, 2, 3]))).toBe(false)
    expect(createdMatches(request(1, 2), created([1, 1]))).toBe(false)
  })

  it("refuses two payments with the same id", () => {
    expect(createdMatches(request(1, 2), created([1, 2], [7, 7]))).toBe(false)
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
    expect(maxRunPayments).toBe(100)
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

describe("fingerprintOf", () => {
  const list = [
    person(1, { amount: "1000000" }),
    person(2, { amount: "2000000" }),
    person(3, { amount: "3000000" }),
  ]

  it("is a short hex hash that holds no id or amount", () => {
    const fingerprint = fingerprintOf(WALLET, list)
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(fingerprint).not.toContain("a0000000")
    expect(fingerprint).not.toContain("1000000")
  })

  it("is stable: the same people and amounts give the same value, in any order", () => {
    const first = fingerprintOf(WALLET, list)
    expect(fingerprintOf(WALLET, [...list])).toBe(first)
    expect(fingerprintOf(WALLET, [list[2], list[0], list[1]])).toBe(first)
    // Only ids and amounts count.
    expect(fingerprintOf(WALLET, [person(1)])).toBe(
      fingerprintOf(WALLET, [person(1, { name: "Renamed" })]),
    )
  })

  it("never changes for a given list: a value saved before a reload is the one computed after", () => {
    expect(fingerprintOf(WALLET, [person(1)])).toBe("0c94734bb2090732")
  })

  it("changes when someone is added or removed, or an id or an amount changes", () => {
    const first = fingerprintOf(WALLET, list)
    expect(fingerprintOf(WALLET, list.slice(1))).not.toBe(first)
    expect(fingerprintOf(WALLET, [...list, person(4)])).not.toBe(first)
    expect(
      fingerprintOf(WALLET, [
        list[0],
        list[1],
        person(9, { amount: "3000000" }),
      ]),
    ).not.toBe(first)
    expect(
      fingerprintOf(WALLET, [
        list[0],
        list[1],
        { ...list[2], amount: "3000001" },
      ]),
    ).not.toBe(first)
  })

  it("does not confuse an id and an amount that run together", () => {
    expect(
      fingerprintOf(WALLET, [
        person(1, { amount: "12" }),
        person(2, { amount: "3" }),
      ]),
    ).not.toBe(
      fingerprintOf(WALLET, [
        person(1, { amount: "1" }),
        person(2, { amount: "23" }),
      ]),
    )
  })

  it("changes with the wallet the run is paid from", () => {
    expect(fingerprintOf(WALLET, list)).not.toBe(
      fingerprintOf("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", list),
    )
  })
})

describe("holdChecking", () => {
  const people = [person(1), person(2), person(3)]

  it("takes the people whose last payment is not settled out of the payable ones", () => {
    const { payable, checking } = holdChecking(people, new Set([guid(2)]))
    expect(payable.map((p) => p.id)).toEqual([guid(1), guid(3)])
    expect(checking.map((p) => p.id)).toEqual([guid(2)])
  })

  it("leaves the roster whole when nobody is being checked", () => {
    const { payable, checking } = holdChecking(people, new Set())
    expect(payable).toEqual(people)
    expect(checking).toEqual([])
  })

  it("keeps a checking person out of a run even when they were ticked by hand", () => {
    const { payable } = holdChecking(people, new Set([guid(1)]))
    const ticked = selectRecipients(payable, new Set(), { [guid(1)]: true })
    expect(ticked.map((p) => p.id)).not.toContain(guid(1))
  })

  it("ignores someone who is not in the roster at all", () => {
    const { payable, checking } = holdChecking(people, new Set([guid(99)]))
    expect(payable).toHaveLength(3)
    expect(checking).toEqual([])
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
