import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/api/errors"
import { listState, loadedItems } from "./pages"

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

  it("is a neutral not found for a 404", () => {
    const error = new ApiError(404, "not_found")
    expect(listState({ ...base, error, loaded: 0, shown: 0 })).toBe("not-found")
  })

  it("keeps the rows when a later page fails", () => {
    const error = new ApiError(503, "auth_unavailable")
    expect(listState({ ...base, error })).toBe("ready")
  })
})
