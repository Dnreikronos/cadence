// Lets one caller through at a time, synchronously. A click handler cannot rely on state
// or on a mutation's `isPending` to refuse a second click: both land after the handler
// returns, and a double click is two handlers in a row. The latch is set before any
// async work starts, so the second click finds it taken.
export type Latch = {
  // True for the caller that took it, false while someone else holds it.
  tryEnter: () => boolean
  release: () => void
  readonly held: boolean
}

export function createLatch(): Latch {
  let held = false
  return {
    tryEnter() {
      if (held) return false
      held = true
      return true
    },
    release() {
      held = false
    },
    get held() {
      return held
    },
  }
}
