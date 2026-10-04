import { expect, test as base } from "@playwright/test"
import { knownNoise } from "./known-noise"

type Watch = {
  // A failed request a test provokes on purpose (a forced mock scenario answers 409, 503
  // and so on) makes Chrome log "Failed to load resource ... status of 409". Name the
  // status and the URL it is expected for; any other console error, the same status on
  // another URL, and any uncaught page error fail the test.
  allowStatus: (status: number, url: RegExp) => void
}

const resourceError =
  /Failed to load resource: the server responded with a status of (\d{3})/

// `test` for every spec: the same as Playwright's, plus a watch over the browser console.
export const test = base.extend<{ watch: Watch }>({
  watch: [
    async ({ context }, use) => {
      const allowed: { status: number; url: RegExp }[] = []
      const problems: string[] = []

      context.on("weberror", (error) => {
        problems.push(`pageerror: ${error.error().message}`)
      })
      context.on("console", (message) => {
        if (message.type() !== "error") return
        const text = message.text()
        const status = Number(resourceError.exec(text)?.[1])
        const { url } = message.location()
        const matches = (n: { status: number; url: RegExp }) =>
          n.status === status && n.url.test(url)
        if (allowed.some(matches) || knownNoise.some(matches)) return
        problems.push(`console.error: ${text} (${url})`)
      })

      await use({
        allowStatus: (status, url) => allowed.push({ status, url }),
      })

      expect(problems, "unexpected browser errors").toEqual([])
    },
    { auto: true },
  ],
})

export { expect }
