// What printing needs from the browser, so a test can stand in for it.
export type PrintEnv = {
  document: { title: string }
  window: {
    print(): void
    addEventListener(type: "afterprint" | "focus", listener: () => void): void
    removeEventListener(
      type: "afterprint" | "focus",
      listener: () => void,
    ): void
  }
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: never) => void
}

const giveUpAfterMs = 60_000

// Prints with `title` as the page title, which names the PDF the browser offers
// to save, and puts the old title back. `afterprint` is not fired everywhere, so
// the window regaining focus or a timeout restores it too: the counterparty's
// name must never stay in the tab title.
export function printWithTitle(
  title: string,
  env: PrintEnv = {
    document,
    window,
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  },
) {
  const previous = env.document.title
  const restore = () => {
    env.document.title = previous
    env.window.removeEventListener("afterprint", restore)
    env.window.removeEventListener("focus", restore)
    env.clearTimeout(timer as never)
  }
  env.document.title = title
  env.window.addEventListener("afterprint", restore)
  env.window.addEventListener("focus", restore)
  const timer = env.setTimeout(restore, giveUpAfterMs)
  env.window.print()
}
