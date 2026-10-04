import {
  MutationObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query"
import { http, HttpResponse } from "msw"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { createApiClient } from "@/lib/api/client"
import { MOCK_ORIGIN } from "@/lib/api/config"
import { ApiError } from "@/lib/api/errors"
import { db, resetDb, type MockAuditor } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import {
  MAX_PAGES,
  MUTATION_TIMEOUT_MS,
  PAGE_SIZE,
  auditorsQuery,
  canRetry,
  inviteAuditorMutation,
  listAllAuditors,
  revokeAuditorMutation,
  type AuditorRow,
} from "./auditors"
import { queryKeys } from "./keys"

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("sonner", () => ({ toast }))
// The hooks bind the app's client, which needs a browser; the factories under test take any client.
vi.mock("@/lib/api", () => ({ api: {} }))

beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  vi.restoreAllMocks()
  server.resetHandlers()
  scenarios.clear()
  resetDb()
})
afterAll(() => server.close())

const client = createApiClient({
  baseUrl: MOCK_ORIGIN,
  getToken: async () => "test-token",
})

const [ana, paulo, rita] = db.auditors

const isInvalidated = (queryClient: QueryClient) =>
  queryClient.getQueryState(queryKeys.auditors.list())?.isInvalidated

// A list in the cache, so an invalidation has something to mark.
function cachedList() {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.auditors.list(), {
    rows: [],
    truncated: false,
  })
  return queryClient
}

const item = (n: number, status = "active") => ({
  id: `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  email: `auditor${n}@audit.example`,
  status,
  invited_at: "2026-10-01T10:00:00.000Z",
})

const listUrl = `${MOCK_ORIGIN}/company/auditors`

describe("listAllAuditors", () => {
  it("maps the seeded auditors, newest invite first, keeping their statuses", async () => {
    const { rows, truncated } = await listAllAuditors(client)
    expect(rows.map((row) => [row.email, row.status])).toEqual([
      [paulo.email, "invited"],
      [rita.email, "invite-expired"],
      [ana.email, "active"],
    ])
    expect(truncated).toBe(false)
  })

  it("asks for pages of the documented size and follows the cursor", async () => {
    for (let n = 0; n < 130; n++) {
      db.auditors.push({
        id: item(n).id,
        email: item(n).email,
        accepted: true,
        invitedAt: new Date(Date.now() - n * 1000).toISOString(),
      })
    }
    const limits: (string | null)[] = []
    server.events.on("request:start", ({ request }) => {
      const url = new URL(request.url)
      if (url.pathname === "/company/auditors") {
        limits.push(url.searchParams.get("limit"))
      }
    })

    const { rows, truncated } = await listAllAuditors(client)

    expect(PAGE_SIZE).toBe(50)
    expect(limits).toEqual(["50", "50", "50"])
    expect(rows).toHaveLength(133)
    expect(truncated).toBe(false)
    server.events.removeAllListeners()
  })

  it("shows a status it does not know as a pending invite", async () => {
    server.use(
      http.get(listUrl, () =>
        HttpResponse.json({
          items: [item(1, "suspended")],
          next_cursor: null,
        }),
      ),
    )
    const { rows } = await listAllAuditors(client)
    expect(rows[0].status).toBe("invited")
  })

  it("lists an id once when pages overlap", async () => {
    server.use(
      http.get(listUrl, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor")
        return HttpResponse.json(
          cursor
            ? { items: [item(2), item(3)], next_cursor: null }
            : { items: [item(1), item(2)], next_cursor: "c1" },
        )
      }),
    )
    const { rows } = await listAllAuditors(client)
    expect(rows.map((row) => row.email)).toEqual([
      item(1).email,
      item(2).email,
      item(3).email,
    ])
  })

  it("stops when the cursor does not move", async () => {
    let requests = 0
    server.use(
      http.get(listUrl, () => {
        requests++
        return HttpResponse.json({ items: [item(1)], next_cursor: "stuck" })
      }),
    )
    const { rows, truncated } = await listAllAuditors(client)
    // One page to learn the cursor, one that comes back with the same one.
    expect(requests).toBe(2)
    expect(rows).toHaveLength(1)
    expect(truncated).toBe(false)
  })

  it("stops at the page cap and says the list is partial", async () => {
    let requests = 0
    server.use(
      http.get(listUrl, () => {
        requests++
        return HttpResponse.json({
          items: [item(requests)],
          next_cursor: `cursor-${requests}`,
        })
      }),
    )
    const { rows, truncated } = await listAllAuditors(client)
    expect(requests).toBe(MAX_PAGES)
    expect(rows).toHaveLength(MAX_PAGES)
    expect(truncated).toBe(true)
  })

  it("is not partial when the last allowed page is also the last", async () => {
    let requests = 0
    server.use(
      http.get(listUrl, () => {
        requests++
        return HttpResponse.json({
          items: [item(requests)],
          next_cursor: requests === MAX_PAGES ? null : `cursor-${requests}`,
        })
      }),
    )
    const { truncated } = await listAllAuditors(client)
    expect(truncated).toBe(false)
  })

  it("fails with the API's error so the screen can offer a retry", async () => {
    scenarios.set("service-down")
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    await expect(queryClient.fetchQuery(auditorsQuery(client))).rejects.toThrow(
      ApiError,
    )
  })
})

describe("canRetry", () => {
  it("offers a retry for a busy service and for a request that timed out", () => {
    expect(canRetry(new ApiError(503, "auth_unavailable"))).toBe(true)
    expect(canRetry(new ApiError(429, "rate_limited"))).toBe(true)
    expect(canRetry(new DOMException("timed out", "TimeoutError"))).toBe(true)
  })

  it("does not for an answer that will not change", () => {
    expect(canRetry(new ApiError(403, "forbidden_role"))).toBe(false)
    expect(canRetry(new ApiError(409, "auditor_already_active"))).toBe(false)
  })
})

// A client whose requests only end when their signal does.
function hangingClient() {
  return createApiClient({
    baseUrl: MOCK_ORIGIN,
    getToken: async () => "test-token",
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener("abort", () => reject(signal.reason))
      }),
  })
}

describe("inviteAuditorMutation", () => {
  const observerFor = (queryClient: QueryClient, source = client) =>
    new MutationObserver(
      queryClient,
      inviteAuditorMutation(source, queryClient),
    )

  it("toasts and refreshes the list with no callback from the caller", async () => {
    const queryClient = cachedList()

    // Nothing is passed to mutate, as when the dialog that called it is gone.
    await observerFor(queryClient).mutate("new@audit.example")

    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      "Invite sent to new@audit.example",
    )
    expect(isInvalidated(queryClient)).toBe(true)
    expect(db.auditors.map((a) => a.email)).toContain("new@audit.example")
  })

  it("is done when the POST answers, not when the list is read again", async () => {
    const queryClient = cachedList()
    // A list on screen whose refetch never ends.
    const observer = new QueryObserver(queryClient, {
      queryKey: queryKeys.auditors.list(),
      queryFn: () => new Promise<never>(() => {}),
    })
    const unsubscribe = observer.subscribe(() => {})

    await observerFor(queryClient).mutate("new@audit.example")

    expect(queryClient.isFetching({ queryKey: queryKeys.auditors.all })).toBe(1)
    unsubscribe()
  })

  it("gives the request a timeout, so a hung one ends and can be retried", async () => {
    const queryClient = cachedList()
    const timeout = new AbortController()
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal)
    const pending = observerFor(queryClient, hangingClient())
      .mutate("new@audit.example")
      .catch((e: unknown) => e)

    timeout.abort(new DOMException("timed out", "TimeoutError"))
    const error = await pending

    expect(spy).toHaveBeenCalledWith(MUTATION_TIMEOUT_MS)
    expect(error).toMatchObject({ name: "TimeoutError" })
    expect(canRetry(error)).toBe(true)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it.each([
    ["auditor_already_invited", 409, paulo.email],
    ["auditor_already_active", 409, ana.email],
  ])("refreshes the list on %s", async (code, status, email) => {
    const queryClient = cachedList()

    const error = await observerFor(queryClient)
      .mutate(email)
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ status, code })
    expect(toast.success).not.toHaveBeenCalled()
    expect(isInvalidated(queryClient)).toBe(true)
  })

  it("leaves the list alone when the service is busy", async () => {
    const queryClient = cachedList()
    scenarios.set("rate-limited")

    const error = await observerFor(queryClient)
      .mutate("new@audit.example")
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 429, code: "rate_limited" })
    expect(canRetry(error)).toBe(true)
    expect(toast.success).not.toHaveBeenCalled()
    expect(isInvalidated(queryClient)).toBe(false)
  })

  it("leaves the list alone when the service is down", async () => {
    const queryClient = cachedList()
    scenarios.set("service-down")

    const error = await observerFor(queryClient)
      .mutate("new@audit.example")
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 503 })
    expect(canRetry(error)).toBe(true)
    expect(toast.success).not.toHaveBeenCalled()
    expect(isInvalidated(queryClient)).toBe(false)
  })

  it("replaces an expired invite", async () => {
    const queryClient = cachedList()

    await observerFor(queryClient).mutate(rita.email)

    const same = db.auditors.filter((a) => a.email === rita.email)
    expect(same).toHaveLength(1)
    expect(same[0].id).not.toBe(rita.id)
  })

  it("accepts the same id back for an expired invite", async () => {
    const queryClient = cachedList()
    server.use(
      http.post(listUrl, () =>
        HttpResponse.json(
          {
            id: rita.id,
            email: rita.email,
            status: "invited",
            invited_at: new Date().toISOString(),
          },
          { status: 201 },
        ),
      ),
    )

    await observerFor(queryClient).mutate(rita.email)

    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      `Invite sent to ${rita.email}`,
    )
    expect(isInvalidated(queryClient)).toBe(true)
  })
})

describe("revokeAuditorMutation", () => {
  const row = (source: MockAuditor, status: AuditorRow["status"]) => ({
    id: source.id,
    email: source.email,
    status,
    invited_at: source.invitedAt,
  })
  const observerFor = (queryClient: QueryClient, source = client) =>
    new MutationObserver(
      queryClient,
      revokeAuditorMutation(source, queryClient),
    )

  it("revokes, says it was access, and refreshes the list", async () => {
    const queryClient = cachedList()

    await observerFor(queryClient).mutate(row(ana, "active"))

    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      `Access revoked for ${ana.email}`,
    )
    expect(isInvalidated(queryClient)).toBe(true)
    expect(db.auditors.map((a) => a.id)).not.toContain(ana.id)
  })

  it("words the toast for a cancelled invite differently", async () => {
    await observerFor(cachedList()).mutate(row(paulo, "invited"))

    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      `Invite cancelled for ${paulo.email}`,
    )
  })

  it("words the toast for an expired invite as a removal", async () => {
    await observerFor(cachedList()).mutate(row(rita, "invite-expired"))

    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      `Expired invite removed for ${rita.email}`,
    )
    expect(db.auditors.map((a) => a.id)).not.toContain(rita.id)
  })

  it("says access was revoked when the invite was accepted after the click", async () => {
    // The row on screen said "invited"; by now the auditor has accepted.
    db.auditors.find((a) => a.id === paulo.id)!.accepted = true

    await observerFor(cachedList()).mutate(row(paulo, "invited"))

    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      `Access revoked for ${paulo.email}`,
    )
  })

  it("falls back to the status clicked when the list cannot be read first", async () => {
    server.use(
      http.get(listUrl, () =>
        HttpResponse.json({ error: "x" }, { status: 500 }),
      ),
    )

    await observerFor(cachedList()).mutate(row(paulo, "invited"))

    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      `Invite cancelled for ${paulo.email}`,
    )
  })

  it("is done when the POST answers, not when the list is read again", async () => {
    const queryClient = cachedList()
    // The first read (before the revoke) answers; the list on screen then hangs.
    const observer = new QueryObserver(queryClient, {
      queryKey: queryKeys.auditors.list(),
      queryFn: () => new Promise<never>(() => {}),
    })
    const unsubscribe = observer.subscribe(() => {})

    await observerFor(queryClient).mutate(row(ana, "active"))

    expect(toast.success).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it("gives both requests a timeout, so a hung one ends and can be retried", async () => {
    const queryClient = cachedList()
    const timeout = new AbortController()
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal)
    const pending = observerFor(queryClient, hangingClient())
      .mutate(row(ana, "active"))
      .catch((e: unknown) => e)

    // The lookup hangs first; its timeout fires, then the revoke itself hangs.
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(10_000))
    timeout.abort(new DOMException("timed out", "TimeoutError"))
    const error = await pending

    expect(spy).toHaveBeenCalledWith(MUTATION_TIMEOUT_MS)
    expect(error).toMatchObject({ name: "TimeoutError" })
    expect(canRetry(error)).toBe(true)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("refreshes the list and says so when the auditor is already gone", async () => {
    const queryClient = cachedList()
    db.auditors.splice(0, db.auditors.length)

    const error = await observerFor(queryClient)
      .mutate(row(ana, "active"))
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 404, code: "auditor_not_found" })
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "That auditor is no longer on your list.",
    )
    expect(isInvalidated(queryClient)).toBe(true)
  })

  it("leaves the list alone when the service is down", async () => {
    const queryClient = cachedList()
    scenarios.set("service-down")

    const error = await observerFor(queryClient)
      .mutate(row(ana, "active"))
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 503 })
    expect(isInvalidated(queryClient)).toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
    expect(db.auditors.map((a) => a.id)).toContain(ana.id)
  })
})
