import type { ShellBalance, ShellCompany } from "./app-shell"

// Stand-ins until the viewer's membership and balance are read (#75, #76).
export const pendingCompany: ShellCompany = { name: "Your company" }
export const pendingBalance: ShellBalance = { state: "hidden" }
