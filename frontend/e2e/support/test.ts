import { expect, test as base } from "@playwright/test"

type Watch = {
  // Failed requests a test provokes on purpose (a forced mock scenario answers 409, 503
  // and so on) make Chrome log "Failed to load resource ... status of 409". Name the
  // status codes the test expects; any other console error, and any uncaught page
  // error, fails the test.
  allowStatus: (...statuses: number[]) => void
}

const resourceError =
  /Failed to load resource: the server responded with a status of (\d{3})/

// Console errors that are known and not this suite's to fix, each with the reason and what
// removes it. Keep this list short: an entry here is a bug somebody else owns.
const knownNoise: { status: number; url: RegExp; why: string }[] = [
  {
    // The recipient's sidebar links to /me/history, which the screen task (H) adds.
    // Next prefetches the link, and the missing route logs a 404. Delete this entry
    // when /me/history is on main.
    status: 404,
    url: /\/me\/history(\?|$)/,
    why: "/me/history does not exist yet (task H)",
  },
]

// `test` for every spec: the same as Playwright's, plus a watch over the browser console.
export const test = base.extend<{ watch: Watch }>({
  watch: [
    async ({ context }, use) => {
      const allowed = new Set<number>()
      const problems: string[] = []

      context.on("weberror", (error) => {
        problems.push(`pageerror: ${error.error().message}`)
      })
      context.on("console", (message) => {
        if (message.type() !== "error") return
        const text = message.text()
        const status = Number(resourceError.exec(text)?.[1])
        if (allowed.has(status)) return
        const { url } = message.location()
        if (knownNoise.some((n) => n.status === status && n.url.test(url))) {
          return
        }
        problems.push(`console.error: ${text} (${url})`)
      })

      await use({
        allowStatus: (...statuses) => statuses.forEach((s) => allowed.add(s)),
      })

      expect(problems, "unexpected browser errors").toEqual([])
    },
    { auto: true },
  ],
})

export { expect }
