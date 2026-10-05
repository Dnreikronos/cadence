import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AmountDisplay } from "./amount-display"

const render = (props: Parameters<typeof AmountDisplay>[0]) =>
  renderToStaticMarkup(createElement(AmountDisplay, props))

describe("AmountDisplay", () => {
  it("shows a revealed amount as plain, readable text", () => {
    const html = render({ amount: 4200 })
    expect(html).toContain("$4,200.00")
    expect(html).not.toContain("invisible")
    expect(html).not.toContain("aria-hidden")
  })

  it.each([
    ["hidden", { state: "hidden" as const, amount: 4200 }],
    ["loading", { state: "loading" as const }],
    ["revealed with no amount yet", { state: "revealed" as const }],
  ])(
    "never puts a real figure in the page, or visible text, when %s",
    (_, props) => {
      const html = render(props)
      expect(html).not.toContain("4,200")
      // The placeholder text only keeps the width: it is invisible, and hidden from
      // assistive technology, so no faded text is left for a contrast check to fail.
      expect(html).toContain("invisible")
      expect(html).toMatch(/aria-hidden="true"[^>]*>\$0,000\.00/)
      expect(html).not.toContain("opacity-55")
    },
  )

  it("draws a shape in place of the figure while it is not shown", () => {
    for (const state of ["hidden", "loading"] as const) {
      expect(render({ state })).toContain("bg-ink/15")
    }
    expect(render({ amount: 1 })).not.toContain("bg-ink/15")
  })

  it("keeps the words a screen reader hears for each state", () => {
    expect(render({ state: "hidden" })).toContain("Encrypted amount")
    expect(render({ state: "loading" })).toContain("Decrypting amount")
    expect(render({ state: "loading" })).toContain('aria-busy="true"')
    expect(render({ amount: 1 })).not.toContain("Encrypted amount")
  })

  it("keeps the shimmer for loading only, and off for reduced motion", () => {
    const loading = render({ state: "loading" })
    expect(loading).toContain("shimmer")
    expect(loading).toContain("motion-reduce:hidden")
    expect(render({ state: "hidden" })).not.toContain("shimmer")
  })
})
