import { setupWorker } from "msw/browser"
import { handlers } from "./handlers"
import { resetDb, db } from "./db"
import { isScenario, scenarioNames, scenarios } from "./scenario"

const worker = setupWorker(...handlers)

let started: Promise<void> | undefined

// Starts the service worker once. `?mock=slow,partial-failure` in the page URL
// turns scenarios on, and `window.cadenceMock` changes them while the app runs.
export function startMockWorker() {
  started ??= worker
    .start({ onUnhandledFrame: "bypass", quiet: true })
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
        },
      })
    })
  return started
}
