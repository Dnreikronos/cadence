import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

// The server action is not under test, and importing it would reach for Supabase.
vi.mock("@/lib/auth/actions", () => ({ signIn: vi.fn() }))

import { EmailCodeForm } from "./email-code-form"

const intent = { invite: null, company: null, next: null }

function render(
  options: { mode?: "sign-in" | "sign-up"; notConfigured?: boolean } = {},
) {
  return renderToStaticMarkup(
    createElement(EmailCodeForm, {
      mode: options.mode ?? "sign-in",
      intent,
      error: null,
      noCompany: false,
      retryHref: null,
      notConfigured: options.notConfigured,
    }),
  )
}

// A tag of the markup, by an attribute it carries.
const tag = (html: string, attribute: string) =>
  html.match(new RegExp(`<(?:input|button)[^>]*${attribute}[^>]*>`))?.[0] ?? ""

// Whether that tag carries the `disabled` attribute (its classes say `disabled:` too).
const disabled = (html: string, attribute: string) =>
  / disabled(=""| |>)/.test(tag(html, attribute))

describe("the sign-in form where Supabase is not configured", () => {
  it("says sign-in is not configured, as a status the screen reader announces", () => {
    const html = render({ notConfigured: true })
    expect(html).toContain('role="status"')
    expect(html).toContain("Sign-in is not configured")
  })

  it("cannot be submitted: the email field and the button are disabled", () => {
    const html = render({ notConfigured: true })
    expect(disabled(html, 'name="email"')).toBe(true)
    expect(disabled(html, 'type="submit"')).toBe(true)
  })

  it("does not put focus in a field that cannot be used", () => {
    expect(tag(render({ notConfigured: true }), 'name="email"')).not.toContain(
      "autofocus",
    )
  })

  it("disables the company name too on sign-up", () => {
    const html = render({ mode: "sign-up", notConfigured: true })
    expect(disabled(html, 'name="company"')).toBe(true)
    expect(disabled(html, 'name="email"')).toBe(true)
    expect(disabled(html, 'type="submit"')).toBe(true)
  })
})

describe("the sign-in form where Supabase is configured", () => {
  it("is usable and says nothing about configuration", () => {
    const html = render()
    expect(html).not.toContain("not configured")
    expect(disabled(html, 'name="email"')).toBe(false)
    expect(disabled(html, 'type="submit"')).toBe(false)
  })
})
