import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SkipLink, mainId } from "./skip-link"

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")

describe("the skip link", () => {
  it("points at the id the main landmark carries", () => {
    const html = renderToStaticMarkup(createElement(SkipLink))
    expect(html).toContain(`href="#${mainId}"`)
    expect(html).toContain("Skip to content")
    expect(mainId).toBe("main")
  })

  it("is hidden until focused: visually hidden, shown on focus-visible", () => {
    const html = renderToStaticMarkup(createElement(SkipLink))
    expect(html).toContain("sr-only")
    expect(html).toContain("focus-visible:not-sr-only")
  })

  // Every page that has the link must have a `main` it can land on: the id, and
  // `tabIndex={-1}` so the browser can move focus there.
  it.each([
    "components/app/app-shell.tsx",
    "app/(auth)/layout.tsx",
    "app/not-found.tsx",
  ])("is paired with a focusable main in %s", (file) => {
    const source = read(file)
    expect(source).toContain("<SkipLink />")
    expect(source).toMatch(/<main[^>]*id=\{mainId\}/s)
    expect(source).toMatch(/<main[^>]*tabIndex=\{-1\}/s)
  })
})
