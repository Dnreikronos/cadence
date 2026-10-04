import { describe, expect, it } from "vitest"
import { leavesPage } from "./leave"

const here = "http://localhost:3213/company/runs/new"

describe("leavesPage", () => {
  it("is true for a link to another page in the app", () => {
    expect(leavesPage({ href: "/company/people" }, here)).toBe(true)
    expect(leavesPage({ href: "/company/runs/new?x=1" }, here)).toBe(true)
    expect(leavesPage({ href: "http://localhost:3213/company" }, here)).toBe(
      true,
    )
  })

  it("is false for the page itself or a jump within it", () => {
    expect(leavesPage({ href: "/company/runs/new" }, here)).toBe(false)
    expect(leavesPage({ href: "#signing" }, here)).toBe(false)
  })

  it("is false for what does not replace the page", () => {
    expect(leavesPage({ href: "/company", target: "_blank" }, here)).toBe(false)
    expect(leavesPage({ href: "/company", modified: true }, here)).toBe(false)
    expect(leavesPage({ href: "/company", button: 1 }, here)).toBe(false)
    expect(leavesPage({ href: "/export.csv", download: true }, here)).toBe(
      false,
    )
    expect(leavesPage({ href: "/company", defaultPrevented: true }, here)).toBe(
      false,
    )
    expect(leavesPage({ href: null }, here)).toBe(false)
  })

  it("leaves another origin to the browser's own prompt", () => {
    expect(leavesPage({ href: "https://example.test/" }, here)).toBe(false)
  })

  it("does not throw on an address it cannot read", () => {
    expect(leavesPage({ href: "http://" }, here)).toBe(false)
  })
})
