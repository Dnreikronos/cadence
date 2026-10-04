import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import type { AmountsRead } from "@/lib/people/amounts"
import { amountsView, currentAmount } from "@/lib/people/view"
import { queryKeys } from "./keys"

// The hooks module pulls in the API client, which reads its mode when loaded.
vi.stubEnv("NEXT_PUBLIC_API_MODE", "mock")
const { recordSavedAmount } = await import("./people")

const key = queryKeys.people.amounts()

function clientWith(read: AmountsRead) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(key, read)
  return client
}

const read = (byPerson: Record<string, string>): AmountsRead => ({
  byPerson,
  truncated: false,
})

// What the screen would derive from the cache right now.
function screenView(client: QueryClient) {
  const state = client.getQueryState<AmountsRead>(key)!
  return amountsView({
    data: state.data,
    isError: state.status === "error",
  })
}

describe("recordSavedAmount", () => {
  it("puts the amount just written in the cache, without a refetch", () => {
    const client = clientWith(read({ a: "4000000000", b: "1000000" }))
    recordSavedAmount(client, { person_id: "a", amount: "5000000000" })
    expect(client.getQueryData<AmountsRead>(key)?.byPerson).toEqual({
      a: "5000000000",
      b: "1000000",
    })
  })

  it("does nothing when the amounts were never read", () => {
    const client = new QueryClient()
    recordSavedAmount(client, { person_id: "a", amount: "1" })
    expect(client.getQueryData(key)).toBeUndefined()
  })

  it("leaves a query that is in error alone: one fresh value does not freshen the rest", async () => {
    const client = clientWith(read({ a: "4000000000", b: "1000000" }))
    await client
      .fetchQuery({
        queryKey: key,
        queryFn: () => Promise.reject(new Error("refresh failed")),
        staleTime: 0,
      })
      .catch(() => {})
    expect(client.getQueryState(key)?.status).toBe("error")

    recordSavedAmount(client, { person_id: "a", amount: "5000000000" })

    // Still stale, not quietly promoted to success.
    expect(client.getQueryState(key)?.status).toBe("error")
    expect(screenView(client).state).toBe("stale")
  })

  // The scenario from the review: 4000 becomes 5000, the PUT succeeds, the
  // refetch fails. The row must say 5000 (the PUT's answer) and the form must
  // not trust the cache, so typing 4000 to undo it is written.
  it("shows the saved figure and tells the form not to trust the cache after a failed refresh", async () => {
    const client = clientWith(read({ a: "4000000000" }))
    recordSavedAmount(client, { person_id: "a", amount: "5000000000" })
    expect(screenView(client)).toMatchObject({
      state: "ready",
      byPerson: { a: "5000000000" },
    })

    await client
      .fetchQuery({
        queryKey: key,
        queryFn: () => Promise.reject(new Error("refresh failed")),
        staleTime: 0,
      })
      .catch(() => {})

    const view = screenView(client)
    expect(view).toMatchObject({
      state: "stale",
      byPerson: { a: "5000000000" },
    })
    expect(currentAmount(view, false, "a")).toEqual({ known: false })
  })
})
