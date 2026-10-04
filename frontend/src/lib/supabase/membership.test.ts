import type { SupabaseClient } from "@supabase/supabase-js"
import { describe, expect, it, vi } from "vitest"
import { membershipOf } from "./membership"

// Records the select and the filter, then answers like PostgREST.
function fake(answer: { data: unknown; error: { message: string } | null }) {
  const select = vi.fn()
  const eq = vi.fn()
  const chain = {
    select: select.mockReturnThis(),
    eq: eq.mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(answer),
  }
  const from = vi.fn(() => chain)
  return { client: { from } as unknown as SupabaseClient, from, select, eq }
}

describe("membershipOf", () => {
  it("selects the company id with its name", async () => {
    const membership = {
      role: "auditor",
      company: { id: "c0000000-0000-4000-8000-000000000001", name: "Solaris" },
    }
    const { client, from, select, eq } = fake({ data: membership, error: null })
    expect(await membershipOf(client, "user-1")).toEqual(membership)
    expect(from).toHaveBeenCalledWith("memberships")
    expect(select).toHaveBeenCalledWith("role, company:companies(id, name)")
    expect(eq).toHaveBeenCalledWith("user_id", "user-1")
  })

  it("is null without a membership", async () => {
    const { client } = fake({ data: null, error: null })
    expect(await membershipOf(client, "user-1")).toBeNull()
  })

  it("throws on a failed lookup instead of reading it as no membership", async () => {
    const { client } = fake({ data: null, error: { message: "boom" } })
    await expect(membershipOf(client, "user-1")).rejects.toThrow(
      "memberships lookup failed: boom",
    )
  })
})
