import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import { ApiError } from "@/lib/api/errors"
import type { Run, RunPayment } from "@/lib/api/schemas"
import { queryKeys } from "./keys"
import { runOptions } from "./payroll"

vi.mock("@/lib/api", () => ({
  api: { runs: { get: vi.fn() } },
  currentUserId: vi.fn(),
}))

afterEach(() => vi.resetAllMocks())

const RUN_ID = "c0000000-0000-4000-8000-000000000001"

function run(...statuses: RunPayment["status"][]): Run {
  return {
    run_id: RUN_ID,
    company_wallet: "1".repeat(32),
    sender: "2".repeat(32),
    mint: "3".repeat(32),
    transaction_version: 1,
    required_signers: ["1".repeat(32)],
    status: "prepared",
    payments: statuses.map((status, position) => ({
      position,
      destination: "4".repeat(32),
      attempt: 0,
      request_id: "a".repeat(64),
      status,
      signature: status === "finalized" ? "5".repeat(88) : null,
      slot: status === "finalized" ? 42 : null,
      error: status === "failed" ? "transaction_failed" : null,
    })),
  }
}

function pollMs(client: QueryClient) {
  const options = runOptions(RUN_ID)
  const query = client
    .getQueryCache()
    .build<Run, Error, Run, ReturnType<typeof queryKeys.runs.detail>>(
      client,
      options,
    )
  const interval = options.refetchInterval
  if (typeof interval !== "function") throw new Error("Missing run interval")
  return interval(query)
}

describe("indexed run reads", () => {
  const client = () =>
    new QueryClient({ defaultOptions: { queries: { retry: false } } })

  it("keeps checking a partly settled run and stops after the last receipt", async () => {
    const cache = client()
    vi.mocked(api.runs.get).mockResolvedValueOnce(run("finalized", "prepared"))
    await cache.fetchQuery(runOptions(RUN_ID))
    expect(pollMs(cache)).toBe(5_000)

    vi.mocked(api.runs.get).mockResolvedValueOnce(run("finalized", "failed"))
    const settled = await cache.fetchQuery(runOptions(RUN_ID))
    expect(settled.payments.map((payment) => payment.status)).toEqual([
      "finalized",
      "failed",
    ])
    expect(pollMs(cache)).toBe(false)
    expect(api.runs.get).toHaveBeenCalledWith(RUN_ID, {
      signal: expect.any(AbortSignal),
    })
    cache.clear()
  })

  it("rereads a cached run when the dashboard opens even with a long stale time", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    })
    cache.setQueryData(queryKeys.runs.detail(RUN_ID), run("prepared"))
    vi.mocked(api.runs.get).mockResolvedValueOnce(run("finalized"))
    const observer = new QueryObserver(cache, runOptions(RUN_ID))
    const unsubscribe = observer.subscribe(() => {})
    try {
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data?.payments[0].status).toBe(
          "finalized",
        ),
      )
      expect(api.runs.get).toHaveBeenCalledTimes(1)
      expect(pollMs(cache)).toBe(false)
    } finally {
      unsubscribe()
      cache.clear()
    }
  })

  it("keeps pending receipts and their polling schedule after a failed refresh", async () => {
    const cache = client()
    vi.mocked(api.runs.get).mockResolvedValueOnce(run("prepared"))
    await cache.fetchQuery(runOptions(RUN_ID))
    vi.mocked(api.runs.get).mockRejectedValueOnce(
      new Error("Service restarting"),
    )
    await expect(cache.fetchQuery(runOptions(RUN_ID))).rejects.toThrow(
      "Service restarting",
    )
    expect(
      cache.getQueryData<Run>(queryKeys.runs.detail(RUN_ID))?.payments[0]
        .status,
    ).toBe("prepared")
    expect(pollMs(cache)).toBe(5_000)
    expect(runOptions(RUN_ID)).toMatchObject({
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    })
    cache.clear()
  })

  it("keeps checking after the initial read exhausts retries and recovers", async () => {
    const cache = client()
    vi.mocked(api.runs.get).mockRejectedValueOnce(
      new ApiError(503, "service_unavailable"),
    )
    await expect(cache.fetchQuery(runOptions(RUN_ID))).rejects.toThrow(
      "service_unavailable",
    )
    expect(cache.getQueryData(queryKeys.runs.detail(RUN_ID))).toBeUndefined()
    expect(pollMs(cache)).toBe(5_000)

    vi.mocked(api.runs.get).mockResolvedValueOnce(run("finalized"))
    await cache.fetchQuery(runOptions(RUN_ID))
    expect(pollMs(cache)).toBe(false)
    cache.clear()
  })

  it.each([401, 403, 404])(
    "stops polling an initial permanent %i error",
    async (status) => {
      const cache = client()
      vi.mocked(api.runs.get).mockRejectedValueOnce(
        new ApiError(status, "request_failed"),
      )
      await expect(cache.fetchQuery(runOptions(RUN_ID))).rejects.toThrow()
      expect(pollMs(cache)).toBe(false)
      cache.clear()
    },
  )

  it("keeps reading an unfamiliar status until the service returns a known outcome", async () => {
    const cache = client()
    vi.mocked(api.runs.get).mockResolvedValueOnce(run("queued"))
    await cache.fetchQuery(runOptions(RUN_ID))
    expect(pollMs(cache)).toBe(5_000)
    vi.mocked(api.runs.get).mockResolvedValueOnce(
      run("expired", "preparation_failed"),
    )
    await cache.fetchQuery(runOptions(RUN_ID))
    expect(pollMs(cache)).toBe(false)
    cache.clear()
  })
})
