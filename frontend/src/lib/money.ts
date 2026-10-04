import { formatUsd } from "@/lib/format"
import { maxBaseUnits, parseUnits } from "@/lib/deposit/schema"

export { formatBaseUnits, maxBaseUnits } from "@/lib/deposit/schema"

// Amounts travel as integer base-unit strings (six decimals), never as floats.
const unitsPerUsd = 1_000_000

const digits = /^\d+$/

function toBigInt(units: string | bigint): bigint {
  if (typeof units === "bigint") {
    if (units < 0n) throw new RangeError("Units cannot be negative")
    return units
  }
  if (!digits.test(units)) throw new RangeError("Units must be whole digits")
  return BigInt(units)
}

// For display. Exact up to 2^48-1 base units (the per-transfer cap): the integer
// is a safe double and one division by 1e6 rounds once, to the nearest double.
export function unitsToUsd(units: string | bigint): number {
  return Number(toBigInt(units)) / unitsPerUsd
}

// Strict: plain digits (or grouped thousands) with at most six decimals, and
// never rounded. Throws a RangeError for anything else, or above 2^48-1 units.
export function usdToUnits(usd: string): string {
  const parsed = parseUnits(usd)
  if (!parsed.ok) throw new RangeError(parsed.message)
  if (parsed.units > maxBaseUnits)
    throw new RangeError("That amount is too large")
  return parsed.units.toString()
}

// "$1,234.50". Display only: whole cents, so sub-cent units show as rounded.
export function formatUnits(units: string | bigint): string {
  return formatUsd(unitsToUsd(units))
}

// Exact, in BigInt, and returned as a string like every other amount.
export function sumUnits(list: readonly (string | bigint)[]): string {
  return list
    .reduce<bigint>((sum, units) => sum + toBigInt(units), 0n)
    .toString()
}
