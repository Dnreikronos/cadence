import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { MutationObserver, QueryClient } from "@tanstack/react-query"
import { createApiClient } from "@/lib/api/client"
import { MOCK_ORIGIN } from "@/lib/api/config"
import { ApiError } from "@/lib/api/errors"
import { db, resetDb } from "@/lib/api/mocks/db"
import { scenarios } from "@/lib/api/mocks/scenario"
import { server } from "@/lib/api/mocks/server"

// The real `@/lib/api` starts a service worker; the tests ask the same handlers over msw.
vi.mock("@/lib/api", () => ({
  api: createApiClient({
    baseUrl: MOCK_ORIGIN,
    getToken: async () => "test-token",
  }),
}))

const {
  companyExportOptions,
  companyPaymentsOptions,
  hasActiveAuditor,
  nextCursor,
} = await import("./payments")

beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => {
  server.resetHandlers()
  scenarios.clear()
  resetDb()
})
afterAll(() => server.close())

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })

describe("nextCursor", () => {
  it("continues from the cursor and stops at the last page", () => {
    expect(nextCursor({ next_cursor: "25" })).toBe("25")
    expect(nextCursor({ next_cursor: null })).toBeUndefined()
  })
})

describe("companyPaymentsOptions", () => {
  it("walks every page by cursor, with no payment twice", async () => {
    const template = db.payments[0]
    for (let i = 0; i < 56; i++) {
      db.payments.push({
        ...template,
        id: `b1000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      })
    }
    const total = db.payments.length // 60
    const result = await client().fetchInfiniteQuery({
      ...companyPaymentsOptions(),
      pages: 5,
    })

    expect(result.pages.map((page) => page.items.length)).toEqual([25, 25, 10])
    expect(result.pages.map((page) => page.next_cursor)).toEqual([
      "25",
      "50",
      null,
    ])
    const ids = result.pages.flatMap((page) =>
      page.items.map((p) => p.payment_id),
    )
    expect(new Set(ids).size).toBe(total)
  })
})

describe("companyExportOptions", () => {
  it("saves the CSV under a dated name and says so, without any screen observing", async () => {
    const save = vi.fn()
    const notify = vi.fn()
    const mutation = new MutationObserver(
      client(),
      companyExportOptions(save, notify),
    )
    // No subscriber: the screen that asked has gone.
    await mutation.mutate()

    expect(save).toHaveBeenCalledOnce()
    const [blob, filename] = save.mock.calls[0]
    expect(filename).toMatch(/^cadence-payments-\d{4}-\d{2}-\d{2}\.csv$/)
    const text = await (blob as Blob).text()
    expect(text.split(/\r?\n/)[0]).toBe(
      "date,counterparty,amount,status,signature",
    )
    expect(text.split(/\r?\n/)).toHaveLength(1 + db.payments.length)
    expect(notify).toHaveBeenCalledWith(`Saved ${filename}`)
  })

  it("saves nothing when the service refuses", async () => {
    scenarios.set("service-down")
    const save = vi.fn()
    const notify = vi.fn()
    const mutation = new MutationObserver(
      client(),
      companyExportOptions(save, notify),
    )

    await expect(mutation.mutate()).rejects.toBeInstanceOf(ApiError)
    expect(save).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})

describe("hasActiveAuditor", () => {
  it("is true only when someone can already read", () => {
    expect(hasActiveAuditor([])).toBe(false)
    expect(
      hasActiveAuditor([{ status: "invited" }, { status: "invite-expired" }]),
    ).toBe(false)
    expect(
      hasActiveAuditor([{ status: "invited" }, { status: "active" }]),
    ).toBe(true)
  })

  it("counts a status it does not know, rather than leave a reader out", () => {
    expect(hasActiveAuditor([{ status: "suspended" }])).toBe(true)
  })
})
