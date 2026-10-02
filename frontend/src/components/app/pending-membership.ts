import type { ShellBalance } from "./app-shell"

// Stand-in until the viewer's private balance is read from the chain.
export const pendingBalance: ShellBalance = { state: "hidden" }
