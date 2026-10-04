import { afterEach, describe, expect, it, vi } from "vitest"
import { datedFilename, saveBlob, type DownloadEnv } from "./download"

afterEach(() => vi.useRealTimers())

describe("datedFilename", () => {
  it("dates the file by the viewer's calendar day, padded", () => {
    expect(datedFilename("cadence-payments", "csv", new Date(2026, 9, 4))).toBe(
      "cadence-payments-2026-10-04.csv",
    )
    expect(datedFilename("x", "csv", new Date(2026, 0, 9, 23, 59))).toBe(
      "x-2026-01-09.csv",
    )
  })
})

describe("saveBlob", () => {
  function fakeEnv() {
    const link = {
      href: "",
      download: "",
      click: vi.fn(),
      remove: vi.fn(),
    }
    const append = vi.fn()
    const env = {
      document: { createElement: vi.fn(() => link), body: { append } },
      url: {
        createObjectURL: vi.fn(() => "blob:fake"),
        revokeObjectURL: vi.fn(),
      },
    } as unknown as DownloadEnv
    return { env, link, append }
  }

  it("clicks a link to the blob under the given name, then cleans up", () => {
    vi.useFakeTimers()
    const { env, link, append } = fakeEnv()
    const blob = new Blob(["a,b"], { type: "text/csv" })

    saveBlob(blob, "file.csv", env)

    expect(env.url.createObjectURL).toHaveBeenCalledWith(blob)
    expect(link).toMatchObject({ href: "blob:fake", download: "file.csv" })
    expect(append).toHaveBeenCalledWith(link)
    expect(link.click).toHaveBeenCalledOnce()
    expect(link.remove).toHaveBeenCalledOnce()
    // Held until the browser has had time to start the download.
    expect(env.url.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(env.url.revokeObjectURL).toHaveBeenCalledWith("blob:fake")
  })
})
