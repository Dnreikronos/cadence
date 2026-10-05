import { formatBaseUnits } from "./schema"

// "2500 USDC", exact: a sub-cent amount must not read as $0.00.
export const describeUsdc = (units: string) =>
  `${formatBaseUnits(BigInt(units))} USDC`

// What was pending before a deposit: base units; `undefined` when nothing was;
// `null` when it is not known (the balance was not read, or not read lately).
export type EarlierPending = string | null | undefined

export type Done = {
  // What this run made private. Absent when only a pending credit was made available.
  amount?: string
  // Applying the pending credit makes all of it available, not only the new deposit.
  earlierPending?: EarlierPending
}

// How an earlier pending credit is named: by its amount when it is known, without one
// when it is not, and not at all when there was none.
function alongside(earlier: EarlierPending): string | null {
  if (earlier === undefined) return null
  return earlier === null
    ? "any earlier pending deposit"
    : `your earlier pending deposit (${describeUsdc(earlier)})`
}

// Worded by what the flow did, not by what the balance now shows: the private balance
// can rise by more than the amount deposited when an earlier pending deposit is applied
// in the same step.
export function doneMessage({ amount, earlierPending }: Done): string {
  if (!amount) return "Your pending USDC is now available to pay people."
  const also = alongside(earlierPending)
  return `${describeUsdc(amount)} is now in your private balance${also ? `, and ${also} with it` : ""}. The move itself is public on-chain.`
}

// No amount in a toast, as everywhere else: it stays in the notice on the page.
export function doneToast({ amount }: Done): string {
  return amount
    ? "Your deposit is now private"
    : "Your pending USDC is now available"
}

// A deposit found confirmed after a reload: it may still be pending, and so may what was
// pending before it.
export function confirmedMessage(earlierPending: EarlierPending): string {
  const also = alongside(earlierPending)
  return `Your last deposit went through. If it is still pending, make it available above${also ? `, together with ${also}` : ""}.`
}

// The record's field read back: absent is not known, "0" is none.
export function earlierFromRecord(stored: string | undefined): EarlierPending {
  if (stored === undefined) return null
  return BigInt(stored) > 0n ? stored : undefined
}

// The balance's pending credit as the controller keeps it, and as a record stores it.
export function earlierFromBalance(
  pending: string | undefined,
): EarlierPending {
  if (pending === undefined) return null
  return BigInt(pending) > 0n ? pending : undefined
}

export function earlierToRecord(earlier: EarlierPending): string | undefined {
  if (earlier === null) return undefined
  return earlier ?? "0"
}
