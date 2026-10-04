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
