import { expect } from "vitest"

// Test helper for the routes that must never carry an amount. A key named for
// one fails, and so does any string or number holding six digits in a row (a
// base-unit amount is that long from 0.1 USDC), except where an id or a
// timestamp is expected to have them.
const identifiers = new Set([
  "id",
  "at",
  "invited_at",
  "paid_at",
  "created_at",
  "payment_id",
  "person_id",
  "run_id",
])

export function expectNoAmount(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    expect(value, path).not.toMatch(/\d{6,}/)
  } else if (typeof value === "number") {
    expect(Math.abs(value), path).toBeLessThan(100_000)
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => expectNoAmount(item, `${path}[${i}]`))
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      expect(key, path).not.toMatch(/amount/i)
      if (identifiers.has(key) && typeof inner === "string") continue
      expectNoAmount(inner, `${path}.${key}`)
    }
  }
}
