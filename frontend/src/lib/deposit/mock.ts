import { baseUnitsToUsdc, maxBaseUnits } from "./schema"
import type { DepositInfo, MakePrivateStep } from "./types"

// Stand-in for the wallet (public balance), the proof service (`POST /wrap`,
// apply-pending) and the chain until the typed client (#79) lands.
const walletAddress = "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5"

// Balances are kept in integer base units (six decimals) so sums stay exact.
let balances = {
  public: 12_500_000_000n,
  private: 84_000_000_000n,
  pending: 0n,
}

function snapshot(): DepositInfo {
  return {
    walletAddress,
    publicUsdc: baseUnitsToUsdc(balances.public),
    publicBaseUnits: balances.public,
    privateUsdc: baseUnitsToUsdc(balances.private),
    pendingUsdc: baseUnitsToUsdc(balances.pending),
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function getDepositInfo(): Promise<DepositInfo> {
  await delay(300)
  return snapshot()
}

// `amount` is an integer count of base units, like the `POST /wrap` body.
export async function makePrivate(
  amount: bigint | string,
  onStep: (step: MakePrivateStep) => void,
): Promise<DepositInfo> {
  const units = typeof amount === "string" ? parseUnits(amount) : amount
  if (units < 1n || units > maxBaseUnits) throw new Error("Invalid amount")
  if (units > balances.public) throw new Error("Not enough public USDC")
  onStep("preparing")
  await delay(700)
  onStep("signing")
  await delay(900)
  onStep("confirming")
  await delay(1200)
  // Confirmed: the wrapped amount lands in the pending balance first.
  balances = {
    ...balances,
    public: balances.public - units,
    pending: balances.pending + units,
  }
  onStep("applying")
  await delay(900)
  balances = {
    ...balances,
    private: balances.private + balances.pending,
    pending: 0n,
  }
  return snapshot()
}

function parseUnits(amount: string): bigint {
  if (!/^\d+$/.test(amount)) throw new Error("Invalid amount")
  return BigInt(amount)
}
