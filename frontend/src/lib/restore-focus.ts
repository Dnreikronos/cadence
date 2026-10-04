import { useRef } from "react"

// Where focus goes when a dialog closes or a control goes away, and the pure rules
// behind it.

type Connectable = { isConnected: boolean }

// The element that had focus when the dialog opened, while it is still on the page and
// the action did not remove what opened it; otherwise the stable fallback.
export function focusTarget<T extends Connectable>(
  origin: T | null,
  originGone: boolean,
  fallback: T | null,
): T | null {
  if (origin && !originGone && origin.isConnected) return origin
  return fallback
}

// What Base UI's `finalFocus` is given: the element to focus, or `true` to leave it to
// the library when there is nothing better (no opener and no fallback).
export function finalFocusFor<T extends Connectable>(
  origin: T | null,
  originGone: boolean,
  fallback: T | null,
): T | true {
  return focusTarget(origin, originGone, fallback) ?? true
}

// Focus is lost when the control that had it is disabled or removed: the browser
// moves it to `<body>`. Anything else is a user who went on, and is left alone.
export function isFocusLost(
  active: Element | null,
  body: Element | null,
  lostFrom?: Element | null,
) {
  return !active || active === body || active === lostFrom
}

// Moves focus to `target` only when it was lost (see `isFocusLost`). For a button that
// disappears with its result, pass it as `lostFrom` while it is still focused.
export function focusIfLost(
  target: HTMLElement | null | undefined,
  lostFrom?: Element | null,
) {
  if (target && isFocusLost(document.activeElement, document.body, lostFrom)) {
    target.focus({ preventScroll: true })
  }
}

// For a dialog opened from a button: `remember()` in the click that opens it, and give
// `finalFocus` to the `Modal`. Closing returns focus to that button, or to the
// fallback if the dialog's own action removed it (`originRemoved()`), so a keyboard user
// never lands on `<body>`. Base UI only returns focus on its own when it has a trigger
// it can see, and ours open from state.
export function useRestoreFocus(getFallback: () => HTMLElement | null) {
  const origin = useRef<HTMLElement | null>(null)
  const gone = useRef(false)
  const fallback = useRef(getFallback)
  fallback.current = getFallback

  return {
    remember(element?: Element | null) {
      const active = element ?? document.activeElement
      origin.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null
      gone.current = false
    },
    originRemoved() {
      gone.current = true
    },
    finalFocus: () =>
      finalFocusFor(origin.current, gone.current, fallback.current()),
  }
}
