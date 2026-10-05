import type { BrowserContext } from "@playwright/test"

// The browser reports a blocked script, style, connection or eval as a
// `securitypolicyviolation` event on the document, whether or not a console error follows.
// Every page and frame of the context forwards it to the array this returns, one line each.
export async function collectCspViolations(context: BrowserContext) {
  const violations: string[] = []
  await context.exposeBinding("reportCspViolation", (_, line: string) => {
    violations.push(line)
  })
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const report = (
        window as unknown as { reportCspViolation?: (line: string) => void }
      ).reportCspViolation
      report?.(
        `${event.violatedDirective} blocked ${event.blockedURI || "inline"} at ${event.sourceFile || location.href}:${event.lineNumber}`,
      )
    })
  })
  return violations
}
