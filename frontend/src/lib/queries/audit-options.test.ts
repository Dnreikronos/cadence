import { QueryClient } from "@tanstack/react-query"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { ApiError } from "@/lib/api/errors"
import { createApiClient } from "@/lib/api/client"
import { MOCK_ORIGIN } from "@/lib/api/config"
import { COMPANY_ID, db, resetDb } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"
import { loadedItems } from "@/lib/audit/pages"
import { queryKeys } from "./keys"
import {
  AUDIT_PAGE_SIZE,
  accessLogOptions,
  auditPaymentsOptions,
} from "./audit-options"

beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => {
  server.resetHandlers()
  scenarios.clear()
  resetDb()
})
afterAll(() => server.close())

const api = createApiClient({
  baseUrl: MOCK_ORIGIN,
  getToken: async () => "test-token",
})
const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })

describe("auditPaymentsOptions", () => {
  it("is keyed by company, so one company's payments never answer for another", () => {
    const other = "c0000000-0000-4000-8000-000000000002"
    expect(auditPaymentsOptions(api, COMPANY_ID).queryKey).toEqual(
      queryKeys.payments.audit(COMPANY_ID, { limit: AUDIT_PAGE_SIZE }),
    )
    expect(auditPaymentsOptions(api, other).queryKey).not.toEqual(
      auditPaymentsOptions(api, COMPANY_ID).queryKey,
    )
  })

  it("loads the company's payments and says there are no more on a short list", async () => {
    const data = await client().fetchInfiniteQuery(
      auditPaymentsOptions(api, COMPANY_ID),
    )
    expect(data.pages).toHaveLength(1)
    expect(loadedItems(data)).toHaveLength(db.payments.length)
    expect(
      auditPaymentsOptions(api, COMPANY_ID).getNextPageParam(
        data.pages[0],
        data.pages,
        undefined,
        [],
      ),
    ).toBeUndefined()
  })

  it("is an empty list for a company with no payments", async () => {
    db.payments.length = 0
    const data = await client().fetchInfiniteQuery(
      auditPaymentsOptions(api, COMPANY_ID),
    )
    expect(loadedItems(data)).toEqual([])
  })

  it("answers 404 for a company that is not theirs", async () => {
    const other = "c0000000-0000-4000-8000-000000000002"
    const error = await client()
      .fetchInfiniteQuery(auditPaymentsOptions(api, other))
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 404, code: "not_found" })
  })
})

describe("accessLogOptions", () => {
  it("follows the cursor page by page until it runs out", async () => {
    const queryClient = client()
    const options = accessLogOptions(api)
    const first = await queryClient.fetchInfiniteQuery(options)
    expect(first.pages[0].items).toHaveLength(AUDIT_PAGE_SIZE)
    expect(first.pages[0].next_cursor).not.toBeNull()

    const both = await queryClient.fetchInfiniteQuery({ ...options, pages: 2 })
    expect(both.pages).toHaveLength(2)
    expect(both.pages[1].items).toHaveLength(
      db.accessLog.length - AUDIT_PAGE_SIZE,
    )
    expect(both.pages[1].next_cursor).toBeNull()
    const ids = loadedItems(both).map((entry) => entry.id)
    expect(new Set(ids).size).toBe(db.accessLog.length)
  })

  it("uses the next cursor and stops on null", () => {
    const { getNextPageParam } = accessLogOptions(api)
    const page = (next_cursor: string | null) => ({ items: [], next_cursor })
    expect(getNextPageParam(page("20"), [], undefined, [])).toBe("20")
    expect(getNextPageParam(page(null), [], undefined, [])).toBeUndefined()
  })

  it("is forbidden for another role", async () => {
    db.role = "admin"
    const error = await client()
      .fetchInfiniteQuery(accessLogOptions(api))
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 403, code: "forbidden_role" })
  })
})
