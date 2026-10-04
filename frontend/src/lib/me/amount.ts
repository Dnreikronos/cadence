import { formatBaseUnits } from "@/lib/money"

// One cent in base units. `formatUsd` rounds to cents, so below this it would show
// "$0.00" for an amount that is not zero.
const CENT = 10_000n

export function isSubCent(units: string): boolean {
  const value = BigInt(units)
  return value > 0n && value < CENT
}

// "0.000001 USDC", exact, for an amount a dollar figure would round away.
export function exactUsdc(units: string): string {
  return `${formatBaseUnits(BigInt(units))} USDC`
}
