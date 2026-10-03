export type DepositInfo = {
  walletAddress: string
  // Plain USDC in the company wallet. Public on-chain.
  publicUsdc: number
  // Confidential balance the company can spend.
  privateUsdc: number
  // Wrapped but not yet applied: confidential credits wait here until the
  // apply-pending step (#68) moves them to the available balance.
  pendingUsdc: number
}

// What the screen can tell the user while "Make private" runs.
export const makePrivateSteps = [
  "preparing",
  "signing",
  "confirming",
  "applying",
] as const
export type MakePrivateStep = (typeof makePrivateSteps)[number]

export const stepLabels: Record<MakePrivateStep, string> = {
  preparing: "Preparing the transaction",
  signing: "Signing with your wallet",
  confirming: "Waiting for the network",
  applying: "Making the balance available",
}
