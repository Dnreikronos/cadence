import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ServiceStatusBanner } from "./service-status-banner"

const render = (status: "down" | "degraded" | null) =>
  renderToStaticMarkup(createElement(ServiceStatusBanner, { status }))

const read = (path: string) =>
  readFileSync(new URL(`./${path}`, import.meta.url), "utf8")

describe("the service status banner", () => {
  it("renders nothing while the service is healthy", () => {
    expect(render(null)).toBe("")
  })

  it("says the service cannot be reached, in the danger colours", () => {
    const html = render("down")
    expect(html).toContain("Can&#x27;t reach Cadence")
    expect(html).toContain("bg-danger-bg")
    expect(html).toContain('role="status"')
  })

  it("says the network cannot be reached, in the warning colours", () => {
    const html = render("degraded")
    expect(html).toContain("Cadence can&#x27;t reach the network")
    expect(html).toContain("bg-warning-bg")
    expect(html).toContain('role="status"')
  })

  it("never tells the reader to try again: it checks on its own", () => {
    for (const status of ["down", "degraded"] as const) {
      const html = render(status)
      expect(html).not.toMatch(/try again/i)
      expect(html).toContain("checks again on its own")
    }
  })

  it("is in every signed-in shell, with the polled status", () => {
    expect(read("app-shell.tsx")).toContain(
      "<ServiceStatusBanner status={serviceStatus}",
    )
    expect(read("role-shell.tsx")).toContain("useServiceStatus()")
  })
})
