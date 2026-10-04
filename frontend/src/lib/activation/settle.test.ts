import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { queryKeys } from "@/lib/queries/keys"
import type { AccountStatus } from "@/lib/api/schemas"
import { settleActivated } from "./settle"

const incomplete: AccountStatus = {
  wallet_linked: true,
  key_enrolled: false,
  account_configured: false,
  pending_credits: false,
}

describe("settleActivated", () => {
  it("makes the cached status complete without waiting for the service", async () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.status.me(), incomplete)

    await settleActivated(client)

    expect(client.getQueryData(queryKeys.status.me())).toEqual({
      wallet_linked: true,
      key_enrolled: true,
      account_configured: true,
      pending_credits: false,
    })
  })

  it("keeps what the service said about pending credits", async () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.status.me(), {
      ...incomplete,
      pending_credits: true,
    })
    await settleActivated(client)
    expect(
      client.getQueryData<AccountStatus>(queryKeys.status.me()),
    ).toMatchObject({ pending_credits: true })
  })

  it("asks the service to confirm, and lets it have the last word", async () => {
    const client = new QueryClient()
    let reads = 0
    const observer = new QueryObserver(client, {
      queryKey: queryKeys.status.me(),
      queryFn: async () => {
        reads += 1
        return incomplete
      },
    })
    const unsubscribe = observer.subscribe(() => {})
    await observer.refetch()
    const before = reads

    await settleActivated(client)

    // Asked again, and the service saying "not yet" is what stays in the cache.
    expect(reads).toBe(before + 1)
    expect(client.getQueryData(queryKeys.status.me())).toEqual(incomplete)
    unsubscribe()
  })

  it("refreshes the balances, which could not be read before the account existed", async () => {
    const client = new QueryClient()
    const key = queryKeys.balance.me({ email: "b@s.test", company: "S" })
    client.setQueryData(key, { available: "0" })
    await settleActivated(client)
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it("does not throw when the confirming read fails", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const observer = new QueryObserver(client, {
      queryKey: queryKeys.status.me(),
      queryFn: async () => {
        throw new Error("down")
      },
    })
    const unsubscribe = observer.subscribe(() => {})
    await expect(settleActivated(client)).resolves.toBeUndefined()
    unsubscribe()
  })
})
