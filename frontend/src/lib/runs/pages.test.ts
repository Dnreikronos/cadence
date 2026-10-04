import { describe, expect, it, vi } from "vitest"
import { collectPages } from "./pages"

describe("collectPages", () => {
  it("follows the cursors to the end, in order", async () => {
    const pages: Record<
      string,
      { items: number[]; next_cursor: string | null }
    > = {
      start: { items: [1, 2], next_cursor: "a" },
      a: { items: [3], next_cursor: "b" },
      b: { items: [4, 5], next_cursor: null },
    }
    const fetchPage = vi.fn(
      async (cursor: string | undefined) => pages[cursor ?? "start"],
    )
    expect(await collectPages(fetchPage)).toEqual([1, 2, 3, 4, 5])
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      "a",
      "b",
    ])
  })

  it("returns an empty list for an empty page", async () => {
    expect(
      await collectPages(async () => ({ items: [], next_cursor: null })),
    ).toEqual([])
  })

  it("gives up on a service that never ends", async () => {
    const fetchPage = vi.fn(async () => ({ items: [1], next_cursor: "again" }))
    await expect(collectPages(fetchPage, 3)).rejects.toThrow(RangeError)
    expect(fetchPage).toHaveBeenCalledTimes(3)
  })

  it("passes a failure on", async () => {
    await expect(
      collectPages(async () => {
        throw new Error("down")
      }),
    ).rejects.toThrow("down")
  })

  it("stops when the page just read is far enough, without asking for more", async () => {
    const fetchPage = vi.fn(async () => ({
      items: [1, 2],
      next_cursor: "more",
    }))
    expect(
      await collectPages(fetchPage, 5, (page) => page.includes(2)),
    ).toEqual([1, 2])
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it("keeps reading while it is not far enough", async () => {
    const fetchPage = vi.fn(async (cursor: string | undefined) =>
      cursor === "b"
        ? { items: [3], next_cursor: null }
        : { items: [cursor === "a" ? 2 : 1], next_cursor: cursor ? "b" : "a" },
    )
    expect(await collectPages(fetchPage, 5, () => false)).toEqual([1, 2, 3])
  })
})
