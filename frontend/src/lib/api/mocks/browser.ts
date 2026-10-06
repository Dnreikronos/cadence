import { setupWorker } from "msw/browser"
import { handlers } from "./handlers"
import { resetAccountStatus, resetDb, db } from "./db"
import { isScenario, scenarioNames, scenarios } from "./scenario"
import { allowMockWorkerUrl, MOCK_WORKER_URL } from "./trusted-types"

const worker = setupWorker(...handlers)

let started: Promise<void> | undefined

// Starts the service worker once. `?mock=slow,partial-failure` in the page URL
// turns scenarios on, and `window.cadenceMock` changes them while the app runs.
export function startMockWorker() {
  allowMockWorkerUrl()
  started ??= worker
    .start({
      serviceWorker: { url: MOCK_WORKER_URL },
      onUnhandledFrame: "bypass",
      quiet: true,
    })
    .then(() => {
      const fromUrl = new URLSearchParams(location.search).get("mock")
      if (fromUrl) scenarios.set(...fromUrl.split(",").filter(isScenario))
      Object.assign(window, {
        cadenceMock: {
          scenarios: scenarioNames,
          set: scenarios.set,
          clear: scenarios.clear,
          active: scenarios.list,
          setRole: (role: typeof db.role) => {
            db.role = role
          },
          reset: resetDb,
          resetAccountStatus,
        },
      })
    })
    // A failed start is dropped, so the next call can try again.
    .catch((error: unknown) => {
      started = undefined
      throw error
    })
  return started
}
