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
import type { Health } from "@/lib/api/schemas"
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

// What a query looks like after a check: an answer, or a failure over what is cached.
const answered = (data: Health) => ({
  status: "success" as const,
  data,
  error: null,
})
const failed = (error: Error, data?: Health) => ({
  status: "error" as const,
  data,
  error,
})

describe("serviceStatusOf", () => {
  it("shows nothing while the first check runs, or when the service is ok", () => {
    expect(
      serviceStatusOf({ status: "pending", data: undefined, error: null }),
    ).toBeNull()
    expect(serviceStatusOf(answered(ok))).toBeNull()
  })

  it("is degraded when the service answers but cannot reach the network", () => {
    expect(serviceStatusOf(answered(unavailable))).toBe("degraded")
    expect(serviceStatusOf(answered({ ...ok, rpc_reachable: false }))).toBe(
      "degraded",
    )
  })

  it("is down when the check cannot reach the service", () => {
    for (const error of [
      new ApiError(0, "network_error"),
      new ApiError(503, "service_unavailable"),
      new ApiError(502, "service_unavailable"),
      new ApiError(504, "request_failed"),
    ]) {
      expect(serviceStatusOf(failed(error))).toBe("down")
    }
  })

  // It answered, so "can't reach" would be wrong: it is failing.
  it("is failing when the service answers with an error of its own", () => {
    expect(serviceStatusOf(failed(new ApiError(500, "internal_error")))).toBe(
      "failing",
    )
  })

  it("is down when a later check fails, even with an ok answer cached", () => {
    expect(serviceStatusOf(failed(new ApiError(0, "network_error"), ok))).toBe(
      "down",
    )
  })

  // The service answered: a 429 is "later", and a drifted body or a 4xx is a bug to fix,
  // not an outage to report. What the last answer said still stands.
  it("does not cry outage over an answer that is not one", () => {
    for (const error of [
      new ApiError(429, "rate_limited", 60),
      new ContractError("/health", "status: invalid"),
      new ApiError(404, "request_failed"),
    ]) {
      expect(serviceStatusOf(failed(error))).toBeNull()
      expect(serviceStatusOf(failed(error, ok))).toBeNull()
      expect(serviceStatusOf(failed(error, unavailable))).toBe("degraded")
    }
  })
})

describe("healthPollMs", () => {
  it("checks again sooner while something is wrong", () => {
    expect(healthPollMs(null)).toBe(60_000)
    expect(healthPollMs("degraded")).toBe(15_000)
    expect(healthPollMs("down")).toBe(15_000)
    expect(healthPollMs("failing")).toBe(15_000)
  })
})

describe("healthOptions", () => {
  const client = () =>
    new QueryClient({ defaultOptions: { queries: { retry: false } } })

  it("shares one cache entry, whoever is signed in", () => {
    expect(healthOptions().queryKey).toEqual(queryKeys.health.all)
  })

  // The app turns focus refetches off; the interval pauses while the tab is hidden.
  it("checks again when the tab comes back or the browser reconnects", () => {
    expect(healthOptions()).toMatchObject({
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    })
  })

  it("reads an ok service from the mock", async () => {
    const data = await client().fetchQuery(healthOptions())
    expect(serviceStatusOf(answered(data))).toBeNull()
  })

  it("reads an unreachable RPC from the mock as degraded", async () => {
    scenarios.set("rpc-down")
    const data = await client().fetchQuery(healthOptions())
    expect(serviceStatusOf(answered(data))).toBe("degraded")
  })

  it("reads a down mock as down", async () => {
    scenarios.set("service-down")
    const error = await client()
      .fetchQuery(healthOptions())
      .then(
        () => new Error("the check answered"),
        (caught: Error) => caught,
      )
    expect(serviceStatusOf(failed(error))).toBe("down")
  })
})
