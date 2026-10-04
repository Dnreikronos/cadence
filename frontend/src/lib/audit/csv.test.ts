import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { REVOKE_AFTER_MS, csvFilename, saveBlob } from "./csv"

const day = new Date(2026, 9, 4, 15, 30)

describe("csvFilename", () => {
  it("names the company and the local date", () => {
    expect(csvFilename("Solaris", day)).toBe(
      "cadence-audit-solaris-2026-10-04.csv",
    )
  })

  it("pads month and day", () => {
    expect(csvFilename("A", new Date(2026, 0, 5))).toBe(
      "cadence-audit-a-2026-01-05.csv",
    )
  })

  it("reduces any name to a safe file name", () => {
    expect(csvFilename("  Acme & Sons / Ltda.  ", day)).toBe(
      "cadence-audit-acme-sons-ltda-2026-10-04.csv",
    )
    expect(csvFilename("../../etc\\passwd", day)).toBe(
      "cadence-audit-etc-passwd-2026-10-04.csv",
    )
  })

  it("falls back when nothing usable is left", () => {
    expect(csvFilename("日本語", day)).toBe(
      "cadence-audit-company-2026-10-04.csv",
    )
    expect(csvFilename("", day)).toBe("cadence-audit-company-2026-10-04.csv")
  })

  it("caps a long name without a trailing dash", () => {
    const name = csvFilename(`${"a".repeat(39)} bbbb`, day)
    expect(name).toBe(`cadence-audit-${"a".repeat(39)}-2026-10-04.csv`)
  })
})

describe("saveBlob", () => {
  const link = {
    href: "",
    download: "",
    rel: "",
    click: vi.fn(),
    remove: vi.fn(),
  }
  const append = vi.fn()
  const create = vi.fn(() => "blob:mock")
  const revoke = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    link.href = link.download = link.rel = ""
    for (const fn of [link.click, link.remove, append, create, revoke]) {
      fn.mockClear()
    }
    vi.stubGlobal("document", {
      createElement: () => link,
      body: { append },
    })
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("downloads the blob under the given name", () => {
    const blob = new Blob(["a,b"], { type: "text/csv" })
    saveBlob(blob, "cadence-audit-solaris-2026-10-04.csv")
    expect(create).toHaveBeenCalledWith(blob)
    expect(link).toMatchObject({
      href: "blob:mock",
      download: "cadence-audit-solaris-2026-10-04.csv",
    })
    expect(append).toHaveBeenCalledWith(link)
    expect(link.click).toHaveBeenCalledOnce()
    expect(link.remove).toHaveBeenCalledOnce()
  })

  it("keeps the object URL alive long enough for the browser to read it", () => {
    saveBlob(new Blob(["x"]), "x.csv")
    vi.advanceTimersByTime(REVOKE_AFTER_MS - 1)
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(revoke).toHaveBeenCalledWith("blob:mock")
    expect(REVOKE_AFTER_MS).toBeGreaterThanOrEqual(10_000)
  })
})
