import {
  maxBaseUnits,
  parseUnits,
  type AmountResult,
} from "@/lib/deposit/schema"

// Validates the typed amount against the available balance, all in integer base units.
export function toWithdrawUnits(
  input: string,
  available: bigint,
): AmountResult {
  const parsed = parseUnits(input)
  if (!parsed.ok) return parsed
  const { units } = parsed
  if (units < 1n) return fail("The amount must be more than zero")
  if (units > available) {
    return fail("That is more than your available balance")
  }
  if (units > maxBaseUnits) return fail("That amount is too large")
  return { ok: true, units }
}

// What "Max" fills in: everything available, up to the per-transfer cap.
export function maxWithdrawUnits(available: bigint): bigint {
  return available < maxBaseUnits ? available : maxBaseUnits
}

function fail(message: string): AmountResult {
  return { ok: false, message }
}
