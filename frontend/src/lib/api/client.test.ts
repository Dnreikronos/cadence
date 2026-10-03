import { describe, expect, it, vi } from "vitest"
import { ZodError } from "zod"
import { createApiClient } from "./client"
import { ApiError, ContractError } from "./errors"

const BASE = "https://api.cadence.test"
const WALLET = "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5"
const GUID = "a0000000-0000-4000-8000-000000000001"

// A client over a fake fetch that counts what leaves it.
function setup(
  answer: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  token: string | null = "test-token",
) {
  const calls: { url: URL; init?: RequestInit }[] = []
  const fetch = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    return answer(url, init)
  })
  const api = createApiClient({
    baseUrl: BASE,
    getToken: async () => token,
    fetch: fetch as typeof globalThis.fetch,
  })
  return { api, calls, fetch }
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

async function caught(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected the call to fail")
}

describe("failures of fetch itself", () => {
  it("maps a fetch TypeError to a retryable network_error", async () => {
    const { api } = setup(() => {
      throw new TypeError("Failed to fetch")
    })
    const error = await caught(api.me.balance())
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 0, code: "network_error" })
    expect((error as ApiError).isRetryable).toBe(true)
  })

  it("rethrows anything else, such as an abort or a failed mock start", async () => {
    const abort = new DOMException("aborted", "AbortError")
    const broken = new Error("the mock worker did not start")
    for (const failure of [abort, broken]) {
      const { api } = setup(() => {
        throw failure
      })
      expect(await caught(api.me.balance())).toBe(failure)
    }
  })

  it("passes the signal to fetch, and an abort is not an ApiError", async () => {
    const controller = new AbortController()
    const { api, calls } = setup(
      (_, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          )
        }),
    )
    const pending = caught(api.me.balance({ signal: controller.signal }))
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].init?.signal).toBe(controller.signal)
    const reason = new Error("left the page")
    controller.abort(reason)
    expect(await pending).toBe(reason)
  })
})

describe("health", () => {
  const down = { status: "unavailable", rpc_reachable: false }

  it("returns the body of a 503 instead of throwing", async () => {
    const { api, calls } = setup(() => json(down, 503))
    expect(await api.health()).toEqual(down)
    expect(calls[0].init?.headers).not.toHaveProperty("authorization")
  })

  it("answers without a token", async () => {
    const { api } = setup(
      () => json({ status: "ok", build_sha: "abc", rpc_reachable: true }),
      null,
    )
    expect((await api.health()).status).toBe("ok")
  })

  it("still throws for every other failure", async () => {
    for (const status of [400, 401, 404, 429, 500, 502]) {
      const { api } = setup(() => json({ error: "nope" }, status))
      expect(await caught(api.health())).toMatchObject({ status })
    }
  })

  it("throws for a 503 that is not a health body, such as a proxy page", async () => {
    const { api } = setup(
      () =>
        new Response("<html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
    )
    expect(await caught(api.health())).toMatchObject({
      status: 503,
      code: "service_unavailable",
    })
  })

  it("fails loudly on a 200 that drifted from the contract", async () => {
    const { api } = setup(() => json({ status: "fine" }))
    expect(await caught(api.health())).toBeInstanceOf(ContractError)
  })
})

describe("ids in paths", () => {
  const bad = [
    "..",
    "../payments",
    "a/b",
    "",
    "%2e%2e",
    GUID + "/..",
    "x".repeat(36),
  ]

  it.each(bad)("never lets %j near a URL", async (value) => {
    const { api, fetch } = setup(() => json({}))
    const calls = [
      () => api.runs.get(value),
      () => api.runs.confirmPayment(value, GUID, "s"),
      () => api.runs.confirmPayment(GUID, value, "s"),
      () => api.runs.retryPayment(value, GUID),
      () => api.runs.retryPayment(GUID, value),
      () => api.company.setAmount(value, "1"),
      () => api.company.invite(value),
      () => api.audit.payments(value),
      () => api.exports.audit(value),
    ]
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(ZodError)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it("builds the path from a valid guid", async () => {
    const { api, calls } = setup(() => json({ items: [], next_cursor: null }))
    await api.audit.payments(GUID, { limit: 5, cursor: "10" })
    expect(calls[0].url.pathname).toBe(`/audit/${GUID}/payments`)
    expect(calls[0].url.search).toBe("?limit=5&cursor=10")
  })
})

describe("downloads", () => {
  it("returns a text/csv body as a Blob", async () => {
    for (const type of ["text/csv", "text/csv; charset=utf-8", "TEXT/CSV"]) {
      const { api } = setup(
        () => new Response("a,b\n", { headers: { "content-type": type } }),
      )
      expect(await (await api.exports.me()).text()).toBe("a,b\n")
    }
  })

  it.each([
    ["text/html", "<html>sign in</html>"],
    ["application/json", "{}"],
    ["text/csvx", "a,b"],
    ["", "a,b"],
  ])("refuses a 200 that is %j", async (type, body) => {
    const { api } = setup(
      () =>
        new Response(body, type ? { headers: { "content-type": type } } : {}),
    )
    const error = await caught(api.exports.company())
    expect(error).toBeInstanceOf(ContractError)
  })

  it("throws the service's error for a failure", async () => {
    const { api } = setup(() => json({ error: "forbidden_role" }, 403))
    expect(await caught(api.exports.me())).toMatchObject({
      status: 403,
      code: "forbidden_role",
    })
  })
})

describe("company balance", () => {
  it("reads GET /company/balance with the balance schema", async () => {
    const body = { available: "84000000000", pending: "0", as_of_slot: 7 }
    const { api, calls } = setup(() => json(body))
    expect(await api.company.balance()).toEqual(body)
    expect(calls[0].url.pathname).toBe("/company/balance")
    expect(calls[0].init?.method).toBe("GET")
  })

  it("fails on a balance that is not base-unit strings", async () => {
    const { api } = setup(() =>
      json({ available: 1.5, pending: "0", as_of_slot: 1 }),
    )
    expect(await caught(api.company.balance())).toBeInstanceOf(ContractError)
  })
})

describe("requests are checked before they are sent", () => {
  it("sends nothing for an invalid body, and rejects with a ZodError", async () => {
    const { api, fetch } = setup(() => json({}))
    const wrap = { company_wallet: WALLET }
    const refused = [
      api.wrap.prepare({ ...wrap, amount: "1.5" }),
      // @ts-expect-error amounts are strings of base units, never numbers
      api.wrap.prepare({ ...wrap, amount: 1000000 }),
      // @ts-expect-error the service refuses keys it does not know
      api.wrap.prepare({ ...wrap, amount: "1", extra: true }),
      api.wrap.prepare({ company_wallet: "short", amount: "1" }),
      api.wrap.confirm({ request_id: "A".repeat(64), signature: "sig" }),
    ]
    for (const call of refused) {
      expect(await caught(call)).toBeInstanceOf(ZodError)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it("sends nothing without a token", async () => {
    const { api, fetch } = setup(() => json({}), null)
    expect(await caught(api.me.balance())).toMatchObject({
      status: 401,
      code: "authentication_required",
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
