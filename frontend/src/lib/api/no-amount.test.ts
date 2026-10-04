import { describe, expect, it } from "vitest"
import { expectNoAmount } from "./no-amount"

describe("expectNoAmount", () => {
  it("lets ids, timestamps and words through", () => {
    expectNoAmount({
      items: [
        {
          id: "e0000000-0000-4000-8000-000000000001",
          at: "2026-10-03T18:00:00Z",
          invited_at: "2026-10-02T09:00:00.000Z",
          scope: "Company payments",
          email: "ana@audit.example",
        },
      ],
      next_cursor: "24",
      wallet_linked: true,
    })
  })

  it.each([
    ["a key named amount", { amount: "x" }],
    ["a nested Amount key", { items: [{ Total_Amount: 1 }] }],
    ["a base-unit string", { scope: "4200000000" }],
    ["six digits inside words", { scope: "paid 420000 today" }],
    ["a long number", { items: [{ balance: 4200000000 }] }],
    ["digits in a field that is not an identifier", { label: "1234567" }],
    ["an id that is a number", { id: 1234567 }],
  ])("rejects %s", (_name, payload) => {
    expect(() => expectNoAmount(payload)).toThrow()
  })

  it("lets five digits through", () => {
    expectNoAmount({ scope: "12345", n: 99_999 })
  })
})
