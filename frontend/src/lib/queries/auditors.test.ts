import { MutationObserver, QueryClient } from "@tanstack/react-query"
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
import { db, resetDb } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import {
  auditorsQuery,
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
  queryClient.setQueryData(queryKeys.auditors.list(), [])
  return queryClient
}

describe("listAllAuditors", () => {
  it("maps the seeded auditors, newest invite first, keeping their statuses", async () => {
    const rows = await listAllAuditors(client)
    expect(rows.map((row) => [row.email, row.status])).toEqual([
      [paulo.email, "invited"],
      [rita.email, "invite-expired"],
      [ana.email, "active"],
    ])
  })

  it("follows the cursor until the last page", async () => {
    for (let n = 0; n < 130; n++) {
      db.auditors.push({
        id: `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        email: `extra${n}@audit.example`,
        accepted: true,
        invitedAt: new Date(Date.now() - n * 1000).toISOString(),
      })
    }
    const rows = await listAllAuditors(client)
    expect(rows).toHaveLength(133)
    expect(new Set(rows.map((row) => row.id)).size).toBe(133)
  })

  it("shows a status it does not know as a pending invite", async () => {
    server.use(
      http.get(`${MOCK_ORIGIN}/company/auditors`, () =>
        HttpResponse.json({
          items: [
            {
              id: ana.id,
              email: ana.email,
              status: "suspended",
              invited_at: ana.invitedAt,
            },
          ],
          next_cursor: null,
        }),
      ),
    )
    const [row] = await listAllAuditors(client)
    expect(row.status).toBe("invited")
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

describe("inviteAuditorMutation", () => {
  it("toasts and refreshes the list with no callback from the caller", async () => {
    const queryClient = cachedList()
    const observer = new MutationObserver(
      queryClient,
      inviteAuditorMutation(client, queryClient),
    )

    // Nothing is passed to mutate, as when the dialog that called it is gone.
    await observer.mutate("new@audit.example")

    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      "Invite sent to new@audit.example",
    )
    expect(isInvalidated(queryClient)).toBe(true)
    expect(db.auditors.map((a) => a.email)).toContain("new@audit.example")
  })

  it("stays quiet when the address already has an invite", async () => {
    const queryClient = cachedList()
    const observer = new MutationObserver(
      queryClient,
      inviteAuditorMutation(client, queryClient),
    )

    const error = await observer.mutate(paulo.email).catch((e: unknown) => e)

    expect(error).toMatchObject({
      status: 409,
      code: "auditor_already_invited",
    })
    expect(toast.success).not.toHaveBeenCalled()
    expect(isInvalidated(queryClient)).toBe(false)
  })

  it("replaces an expired invite", async () => {
    const queryClient = cachedList()
    const observer = new MutationObserver(
      queryClient,
      inviteAuditorMutation(client, queryClient),
    )

    await observer.mutate(rita.email)

    const same = db.auditors.filter((a) => a.email === rita.email)
    expect(same).toHaveLength(1)
    expect(same[0].id).not.toBe(rita.id)
  })
})

describe("revokeAuditorMutation", () => {
  const row = (
    source: (typeof db.auditors)[number],
    status: AuditorRow["status"],
  ) => ({
    id: source.id,
    email: source.email,
    status,
    invited_at: source.invitedAt,
  })

  it("revokes, says which kind of removal it was and refreshes the list", async () => {
    const queryClient = cachedList()
    const observer = new MutationObserver(
      queryClient,
      revokeAuditorMutation(client, queryClient),
    )

    await observer.mutate(row(ana, "active"))

    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      `Access revoked for ${ana.email}`,
    )
    expect(isInvalidated(queryClient)).toBe(true)
    expect(db.auditors.map((a) => a.id)).not.toContain(ana.id)
  })

  it("words the toast for a cancelled invite differently", async () => {
    const queryClient = cachedList()
    const observer = new MutationObserver(
      queryClient,
      revokeAuditorMutation(client, queryClient),
    )

    await observer.mutate(row(paulo, "invited"))

    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      `Invite cancelled for ${paulo.email}`,
    )
  })

  it("refreshes the list when the auditor is already gone", async () => {
    const queryClient = cachedList()
    const observer = new MutationObserver(
      queryClient,
      revokeAuditorMutation(client, queryClient),
    )
    db.auditors.splice(0, db.auditors.length)

    const error = await observer.mutate(row(ana, "active")).catch((e) => e)

    expect(error).toMatchObject({ status: 404, code: "auditor_not_found" })
    expect(toast.success).not.toHaveBeenCalled()
    expect(isInvalidated(queryClient)).toBe(true)
  })

  it("leaves the list alone when the service is down", async () => {
    const queryClient = cachedList()
    const observer = new MutationObserver(
      queryClient,
      revokeAuditorMutation(client, queryClient),
    )
    scenarios.set("service-down")

    const error = await observer.mutate(row(ana, "active")).catch((e) => e)

    expect(error).toMatchObject({ status: 503 })
    expect(isInvalidated(queryClient)).toBe(false)
    expect(db.auditors.map((a) => a.id)).toContain(ana.id)
  })
})
