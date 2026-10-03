import { setupServer } from "msw/node"
import { handlers } from "./handlers"

// For tests: the same handlers the browser uses.
export const server = setupServer(...handlers)
