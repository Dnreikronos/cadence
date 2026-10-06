// The page's policy requires Trusted Types for script sinks (src/lib/security-headers.ts).
// MSW turns its worker URL into a string before registering it, so no typed value can
// reach `navigator.serviceWorker.register`. A mock build's policy allows a `default`
// policy, which the browser consults for a plain string: this one turns exactly the
// worker's URL into a script URL and refuses everything else (no HTML, no script, no
// other URL), so a mock build stays as strict as a real one everywhere but there.
export const MOCK_WORKER_URL = "/mockServiceWorker.js"

type TrustedTypes = {
  createPolicy(
    name: string,
    rules: { createScriptURL(url: string): string | null },
  ): unknown
}

let installed = false

export function allowMockWorkerUrl() {
  const trustedTypes = (globalThis as { trustedTypes?: TrustedTypes })
    .trustedTypes
  if (installed || !trustedTypes) return
  const worker = new URL(MOCK_WORKER_URL, location.href).href
  trustedTypes.createPolicy("default", {
    createScriptURL: (url) =>
      new URL(url, location.href).href === worker ? url : null,
  })
  installed = true
}
