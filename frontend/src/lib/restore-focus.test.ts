import { describe, expect, it } from "vitest"
import { finalFocusFor, focusTarget, isFocusLost } from "./restore-focus"

const el = (isConnected: boolean) => ({ isConnected, name: "el" })

describe("focusTarget", () => {
  const origin = el(true)
  const fallback = el(true)

  it("returns focus to the button that opened the dialog", () => {
    expect(focusTarget(origin, false, fallback)).toBe(origin)
  })

  it("falls back when the action removed what opened the dialog", () => {
    expect(focusTarget(origin, true, fallback)).toBe(fallback)
  })

  it("falls back when the opener is no longer on the page", () => {
    expect(focusTarget(el(false), false, fallback)).toBe(fallback)
  })

  it("falls back when nothing was remembered", () => {
    expect(focusTarget(null, false, fallback)).toBe(fallback)
  })

  it("is null when there is no fallback either, so the caller can leave it to the browser", () => {
    expect(focusTarget(null, true, null)).toBeNull()
  })
})

describe("finalFocusFor", () => {
  it("hands over the element, and leaves it to the library when there is none", () => {
    const origin = el(true)
    const fallback = el(true)
    expect(finalFocusFor(origin, false, fallback)).toBe(origin)
    expect(finalFocusFor(origin, true, fallback)).toBe(fallback)
    expect(finalFocusFor(null, false, null)).toBe(true)
    expect(finalFocusFor(el(false), false, null)).toBe(true)
  })
})

describe("isFocusLost", () => {
  const body = { id: "body" } as unknown as Element
  const button = { id: "button" } as unknown as Element
  const other = { id: "other" } as unknown as Element

  it("is lost on the body or on nothing", () => {
    expect(isFocusLost(body, body)).toBe(true)
    expect(isFocusLost(null, body)).toBe(true)
  })

  it("is lost while it is still on the control that is about to go away", () => {
    expect(isFocusLost(button, body, button)).toBe(true)
  })

  it("is not lost when the user moved on to something else", () => {
    expect(isFocusLost(other, body, button)).toBe(false)
    expect(isFocusLost(other, body)).toBe(false)
  })
})
