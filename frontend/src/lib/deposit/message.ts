import { formatBaseUnits } from "./schema"

// "2500 USDC", exact: a sub-cent amount must not read as $0.00.
export const describeUsdc = (units: string) =>
  `${formatBaseUnits(BigInt(units))} USDC`

export type Done = {
  // What this run made private. Absent when only a pending credit was made available.
  amount?: string
  // What was already pending when the run started: applying the pending credit makes
  // all of it available, not only the new deposit.
  earlierPending?: string
}

// Worded by what the flow did, not by what the balance now shows: the private balance
// can rise by more than the amount deposited when an earlier pending deposit is applied
// in the same step.
export function doneMessage({ amount, earlierPending }: Done): string {
  if (!amount) return "Your pending USDC is now available to pay people."
  const also = earlierPending
    ? `, and your earlier pending deposit (${describeUsdc(earlierPending)}) with it`
    : ""
  return `${describeUsdc(amount)} is now in your private balance${also}. The move itself is public on-chain.`
}

export function doneToast({ amount, earlierPending }: Done): string {
  if (!amount) return "Your pending USDC is now available"
  return earlierPending
    ? `${describeUsdc(amount)} is now private, with your earlier pending deposit`
    : `${describeUsdc(amount)} is now private`
}
