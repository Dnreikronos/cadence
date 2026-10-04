import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { invalidateBalances } from "./invalidate"
import { queryKeys } from "./keys"

const ana = { email: "ana@solaris.test", company: "Solaris" }
const bruno = { email: "bruno@solaris.test", company: "Solaris" }

describe("invalidateBalances", () => {
  it("marks every cached balance stale, and nothing else", async () => {
    const client = new QueryClient()
    const keys = [
      queryKeys.balance.company(ana),
      queryKeys.balance.me(bruno),
      queryKeys.people.list(),
      queryKeys.payments.company(),
    ]
    for (const key of keys) client.setQueryData(key, { value: 1 })

    await invalidateBalances(client)

    const stale = keys.map((key) => client.getQueryState(key)?.isInvalidated)
    expect(stale).toEqual([true, true, false, false])
  })

  it("refetches a balance that is on screen", async () => {
    const client = new QueryClient()
    let calls = 0
    const observer = new QueryObserver(client, {
      queryKey: queryKeys.balance.me(ana),
      queryFn: async () => ++calls,
    })
    // A subscribed observer is what the mounted sidebar is.
    const unsubscribe = observer.subscribe(() => {})
    await observer.refetch()
    expect(observer.getCurrentResult().data).toBe(1)

    await invalidateBalances(client)

    expect(calls).toBe(2)
    expect(observer.getCurrentResult().data).toBe(2)
    unsubscribe()
  })
})
