import { describe, expect, it } from "vitest"
import { z } from "zod"
import "./zod-config"

describe("zod config", () => {
  it("is jitless, so the `new Function` probe never runs", () => {
    expect(z.config().jitless).toBe(true)
    expect(z.core.util.allowsEval.value).toBe(false)
  })

  it("still parses and rejects objects, strictly and with defaults", () => {
    const schema = z.strictObject({
      email: z.email(),
      amount: z.string().regex(/^\d+$/),
      tags: z.array(z.string()).default([]),
    })
    expect(schema.parse({ email: "a@b.co", amount: "12" })).toEqual({
      email: "a@b.co",
      amount: "12",
      tags: [],
    })
    expect(schema.safeParse({ email: "a@b.co", amount: "1.5" }).success).toBe(
      false,
    )
    expect(
      schema.safeParse({ email: "a@b.co", amount: "1", extra: true }).success,
    ).toBe(false)
  })
})
