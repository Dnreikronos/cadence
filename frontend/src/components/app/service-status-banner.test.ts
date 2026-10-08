import { type ComponentProps, createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { ServiceStatus } from "@/lib/queries/health"
import { AppShell } from "./app-shell"
import { ServiceStatusBanner } from "./service-status-banner"

// The shell's sidebar reads the route; outside the app router there is none.
vi.mock("next/navigation", () => ({ usePathname: () => "/company" }))

const render = (status: ServiceStatus | null) =>
  renderToStaticMarkup(createElement(ServiceStatusBanner, { status }))

const statuses = ["down", "failing", "degraded"] as const

describe("the service status banner", () => {
  // A live region that appears already filled is often not read out, so it is always
  // there and only its contents change.
  it("keeps an empty live region while the service is healthy", () => {
    expect(render(null)).toBe('<div role="status" class="print:hidden"></div>')
  })

  it("says the service cannot be reached, in the danger colours", () => {
    const html = render("down")
    expect(html).toContain("Can&#x27;t reach Cadence")
    expect(html).toContain("bg-danger-bg")
  })

  it("says the service is failing when it answers with an error", () => {
    const html = render("failing")
    expect(html).toContain("Cadence is having trouble")
    expect(html).not.toContain("reach")
    expect(html).toContain("bg-danger-bg")
  })

  it("says Solana cannot be reached, in the warning colours", () => {
    const html = render("degraded")
    expect(html).toContain("Cadence can&#x27;t reach Solana")
    expect(html).toContain("bg-warning-bg")
  })

  it("is a polite status, never an alert, inside the one live region", () => {
    for (const status of statuses) {
      const html = render(status)
      expect(html.startsWith('<div role="status"')).toBe(true)
      expect(html.match(/role=/g)).toHaveLength(1)
    }
  })

  it("never tells the reader to try again: it checks on its own", () => {
    for (const status of statuses) {
      const html = render(status)
      expect(html).not.toMatch(/try again/i)
      expect(html).toContain("checks again on its own")
    }
  })

  it("sits above the screen in the signed-in shell", () => {
    const html = renderToStaticMarkup(
      createElement(
        AppShell,
        {
          role: "admin",
          company: { name: "Solaris" },
          email: "ana@solaris.test",
          serviceStatus: "degraded",
          // The screen goes in as the third argument, as JSX would pass it.
        } as ComponentProps<typeof AppShell>,
        createElement("h1", null, "Payments"),
      ),
    )
    const main = html.slice(html.indexOf("<main"))
    expect(main.indexOf("can&#x27;t reach Solana")).toBeGreaterThan(-1)
    expect(main.indexOf("can&#x27;t reach Solana")).toBeLessThan(
      main.indexOf("Payments"),
    )
  })
})
