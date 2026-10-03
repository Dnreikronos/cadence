import type { DepositInfo, MakePrivateStep } from "./types"

// Stand-in for the wallet (public balance), the proof service (`POST /wrap`,
// apply-pending) and the chain until the typed client (#79) lands.
let info: DepositInfo = {
  walletAddress: "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5",
  publicUsdc: 12_500,
  privateUsdc: 84_000,
  pendingUsdc: 0,
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function getDepositInfo(): Promise<DepositInfo> {
  await delay(300)
  return { ...info }
}

export async function makePrivate(
  amount: number,
  onStep: (step: MakePrivateStep) => void,
): Promise<DepositInfo> {
  if (amount > info.publicUsdc) throw new Error("Not enough public USDC")
  onStep("preparing")
  await delay(700)
  onStep("signing")
  await delay(900)
  onStep("confirming")
  await delay(1200)
  // Confirmed: the wrapped amount lands in the pending balance first.
  info = {
    ...info,
    publicUsdc: info.publicUsdc - amount,
    pendingUsdc: info.pendingUsdc + amount,
  }
  onStep("applying")
  await delay(900)
  info = {
    ...info,
    privateUsdc: info.privateUsdc + info.pendingUsdc,
    pendingUsdc: 0,
  }
  return { ...info }
}
