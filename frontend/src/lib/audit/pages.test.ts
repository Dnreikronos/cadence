import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/api/errors"
import {
  canRetry,
  listState,
  loadedItems,
  loadedMessage,
  showFilterNote,
} from "./pages"

describe("loadedItems", () => {
  it("is empty before anything loaded", () => {
    expect(loadedItems(undefined)).toEqual([])
    expect(loadedItems({ pages: [] })).toEqual([])
  })

  it("joins the pages in order", () => {
    expect(
      loadedItems({
        pages: [{ items: [1, 2] }, { items: [] }, { items: [3] }],
      }),
    ).toEqual([1, 2, 3])
  })
})

describe("listState", () => {
  const base = { isPending: false, error: null, loaded: 3, shown: 3 }

  it("is loading until the first page answers", () => {
    expect(listState({ ...base, isPending: true, loaded: 0, shown: 0 })).toBe(
      "loading",
    )
  })

  it("is ready with rows", () => {
    expect(listState(base)).toBe("ready")
  })

  it("is empty when nothing was ever returned", () => {
    expect(listState({ ...base, loaded: 0, shown: 0 })).toBe("empty")
  })

  it("tells filters that match nothing from an empty list", () => {
    expect(listState({ ...base, shown: 0 })).toBe("no-match")
  })

  it("is an error when the first page failed", () => {
    const error = new ApiError(503, "auth_unavailable")
    expect(listState({ ...base, error, loaded: 0, shown: 0 })).toBe("error")
  })

  it("is a neutral not found for the company's 404", () => {
    const error = new ApiError(404, "not_found")
    expect(
      listState({
        ...base,
        error,
        loaded: 0,
        shown: 0,
        companyScoped: true,
      }),
    ).toBe("not-found")
  })

  it("treats a 404 with any other code as an error that can be retried", () => {
    const error = new ApiError(404, "route_not_found")
    expect(
      listState({
        ...base,
        error,
        loaded: 0,
        shown: 0,
        companyScoped: true,
      }),
    ).toBe("error")
    expect(canRetry(error)).toBe(true)
  })

  it("never calls a list without a company not found", () => {
    const error = new ApiError(404, "not_found")
    expect(listState({ ...base, error, loaded: 0, shown: 0 })).toBe("error")
  })

  it("does not read a 403 for the company as not found", () => {
    const error = new ApiError(403, "forbidden_role")
    expect(
      listState({
        ...base,
        error,
        loaded: 0,
        shown: 0,
        companyScoped: true,
      }),
    ).toBe("error")
  })

  it("keeps the rows when a later page fails", () => {
    const error = new ApiError(503, "auth_unavailable")
    expect(listState({ ...base, error })).toBe("ready")
  })
})

describe("canRetry", () => {
  it("offers a retry for a hiccup, a missing route and an unknown failure", () => {
    expect(canRetry(new ApiError(503, "auth_unavailable"))).toBe(true)
    expect(canRetry(new ApiError(429, "rate_limited"))).toBe(true)
    expect(canRetry(new ApiError(404, "not_found"))).toBe(true)
    expect(canRetry(new Error("boom"))).toBe(true)
  })

  it("does not offer one for an answer that asking again cannot change", () => {
    expect(canRetry(new ApiError(403, "forbidden_role"))).toBe(false)
    expect(canRetry(new ApiError(401, "authentication_required"))).toBe(false)
  })
})

describe("showFilterNote", () => {
  it("shows only with a filter on and more pages to load", () => {
    expect(showFilterNote(true, true)).toBe(true)
    expect(showFilterNote(true, false)).toBe(false)
    expect(showFilterNote(false, true)).toBe(false)
    expect(showFilterNote(false, false)).toBe(false)
  })
})

describe("loadedMessage", () => {
  it("says how many rows arrived", () => {
    expect(loadedMessage(20, 25)).toBe("Loaded 5 more")
    expect(loadedMessage(0, 1)).toBe("Loaded 1 more")
  })

  it("says nothing when the count did not grow", () => {
    expect(loadedMessage(20, 20)).toBe("")
    expect(loadedMessage(20, 0)).toBe("")
  })
})
