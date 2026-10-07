import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { createApiClient } from "@/lib/api/client"
import { MOCK_ORIGIN } from "@/lib/api/config"
import { ApiError, ContractError } from "@/lib/api/errors"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { queryKeys } from "./keys"

// The real `@/lib/api` starts a service worker; the tests ask the same handlers over msw.
vi.mock("@/lib/api", () => ({
  api: createApiClient({ baseUrl: MOCK_ORIGIN, getToken: async () => null }),
}))

const { healthOptions, healthPollMs, serviceStatusOf } =
  await import("./health")

beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => {
  server.resetHandlers()
  scenarios.clear()
})
afterAll(() => server.close())

const ok = { status: "ok", build_sha: "abc", rpc_reachable: true } as const
const unavailable = { status: "unavailable", rpc_reachable: false } as const

describe("serviceStatusOf", () => {
  it("shows nothing while the first check runs, or when the service is ok", () => {
    expect(serviceStatusOf({ isError: false })).toBeNull()
    expect(serviceStatusOf({ isError: false, data: ok })).toBeNull()
  })

  it("is degraded when the service answers but cannot reach the network", () => {
    expect(serviceStatusOf({ isError: false, data: unavailable })).toBe(
      "degraded",
    )
    expect(
      serviceStatusOf({
        isError: false,
        data: { ...ok, rpc_reachable: false },
      }),
    ).toBe("degraded")
  })

  it("is down when the check cannot reach the service or it fails", () => {
    for (const error of [
      new ApiError(0, "network_error"),
      new ApiError(503, "service_unavailable"),
      new ApiError(502, "service_unavailable"),
    ]) {
      expect(serviceStatusOf({ isError: true, error })).toBe("down")
    }
  })

  it("is down when a later check fails, even with an ok answer cached", () => {
    expect(
      serviceStatusOf({
        isError: true,
        error: new ApiError(0, "network_error"),
        data: ok,
      }),
    ).toBe("down")
  })

  // The service answered: a drifted body or a 4xx is a bug to fix, not an outage to report.
  it("does not cry outage over an answer that is not one", () => {
    for (const error of [
      new ContractError("/health", "status: invalid"),
      new ApiError(404, "request_failed"),
    ]) {
      expect(serviceStatusOf({ isError: true, error })).toBeNull()
    }
  })
})

describe("healthPollMs", () => {
  it("checks again sooner while something is wrong", () => {
    expect(healthPollMs(null)).toBe(60_000)
    expect(healthPollMs("degraded")).toBe(15_000)
    expect(healthPollMs("down")).toBe(15_000)
  })
})

describe("healthOptions", () => {
  const client = () =>
    new QueryClient({ defaultOptions: { queries: { retry: false } } })

  it("shares one cache entry, whoever is signed in", () => {
    expect(healthOptions().queryKey).toEqual(queryKeys.health.all)
  })

  it("reads an ok service from the mock", async () => {
    const data = await client().fetchQuery(healthOptions())
    expect(serviceStatusOf({ isError: false, data })).toBeNull()
  })

  it("reads an unreachable RPC from the mock as degraded", async () => {
    scenarios.set("rpc-down")
    const data = await client().fetchQuery(healthOptions())
    expect(serviceStatusOf({ isError: false, data })).toBe("degraded")
  })

  it("reads a down mock as down", async () => {
    scenarios.set("service-down")
    const error = await client()
      .fetchQuery(healthOptions())
      .catch((caught: unknown) => caught)
    expect(serviceStatusOf({ isError: true, error })).toBe("down")
  })
})
