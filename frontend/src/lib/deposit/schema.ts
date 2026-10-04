const decimals = 6
const unitsPerUsdc = 10n ** BigInt(decimals)

// A wrap deposit is capped at 2^48-1 base units (six decimals), like transfers.
export const maxBaseUnits = 2n ** 48n - 1n

// Plain digits, or digits with valid thousands commas. A lone "1,5" (a pt-BR
// decimal) must not read as 15.
const plainAmount = /^\d*\.?\d*$/
const groupedAmount = /^\d{1,3}(,\d{3})+(\.\d*)?$/

// Returns the amount as a plain decimal string, or undefined when it is empty
// or not a number. Never goes through floats.
export function parseAmount(input: string): string | undefined {
  const trimmed = input.trim()
  if (!/\d/.test(trimmed)) return undefined
  if (plainAmount.test(trimmed)) return trimmed
  if (groupedAmount.test(trimmed)) return trimmed.replaceAll(",", "")
  return undefined
}

export type AmountResult =
  { ok: true; units: bigint } | { ok: false; message: string }

// Reads a typed amount into integer base units. Zero is a valid reading; limits are the caller's.
export function parseUnits(input: string): AmountResult {
  const amount = parseAmount(input)
  if (amount === undefined) return fail("Enter an amount")
  const [whole, fraction = ""] = amount.split(".")
  if (fraction.length > decimals) return fail("Use at most six decimal places")
  return {
    ok: true,
    units:
      BigInt(whole || "0") * unitsPerUsdc +
      BigInt(fraction.padEnd(decimals, "0")),
  }
}

// Validates the typed amount against the public balance, all in integer base units.
export function toBaseUnits(input: string, available: bigint): AmountResult {
  const parsed = parseUnits(input)
  if (!parsed.ok) return parsed
  const { units } = parsed
  if (units < 1n) return fail("The amount must be more than zero")
  if (units > available) return fail("That is more public USDC than you hold")
  if (units > maxBaseUnits) return fail("That amount is too large")
  return { ok: true, units }
}

// Plain decimal string with up to six fraction digits and no trailing zeros.
export function formatBaseUnits(units: bigint): string {
  const whole = units / unitsPerUsdc
  const fraction = String(units % unitsPerUsdc)
    .padStart(decimals, "0")
    .replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : String(whole)
}

// For display only; a safe integer divided by 1e6 is exact enough to show.
export function baseUnitsToUsdc(units: bigint): number {
  return Number(units) / Number(unitsPerUsdc)
}

function fail(message: string): AmountResult {
  return { ok: false, message }
}
