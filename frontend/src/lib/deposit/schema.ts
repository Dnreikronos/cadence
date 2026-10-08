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

// What to say to someone who typed a decimal comma ("1,5", "4200,50"). The parser stays
// strict, since a comma is only a thousands separator here, so this says how to type it
// instead of the bare "Enter an amount". One wording for every amount field.
export const DECIMAL_HINT = "Use digits and a dot for decimals, like 1.50"

// A comma that reads as a decimal point: digits, then a comma and the rest ("1,5",
// "4200,50", "4.200,50"). Whatever parses as grouped thousands ("1,500") never gets here.
export function isCommaDecimal(input: string): boolean {
  return /^\d[\d.]*,\d*$/.test(input.trim())
}

export type AmountResult =
  { ok: true; units: bigint } | { ok: false; message: string }

// Reads a typed amount into integer base units. Zero is a valid reading; limits are the caller's.
export function parseUnits(input: string): AmountResult {
  const amount = parseAmount(input)
  if (amount === undefined) {
    return fail(isCommaDecimal(input) ? DECIMAL_HINT : "Enter an amount")
  }
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

// The sign, whole USDC and all six fraction digits, by integer math on the absolute
// value: a bare remainder of -1n would print as "0.0000-1".
function splitBaseUnits(units: bigint) {
  const abs = units < 0n ? -units : units
  return {
    sign: units < 0n ? "-" : "",
    whole: abs / unitsPerUsdc,
    fraction: String(abs % unitsPerUsdc).padStart(decimals, "0"),
  }
}

// Plain decimal string with up to six fraction digits and no trailing zeros.
export function formatBaseUnits(units: bigint): string {
  const { sign, whole, fraction } = splitBaseUnits(units)
  const trimmed = fraction.replace(/0+$/, "")
  return trimmed ? `${sign}${whole}.${trimmed}` : `${sign}${whole}`
}

// Decimal string with exactly six fraction digits, "4200.000000" (the CSV export's
// amount, docs/dev/API_CONTRACT.md).
export function formatUsdcFixed(units: bigint): string {
  const { sign, whole, fraction } = splitBaseUnits(units)
  return `${sign}${whole}.${fraction}`
}

// For display only; a safe integer divided by 1e6 is exact enough to show.
export function baseUnitsToUsdc(units: bigint): number {
  return Number(units) / Number(unitsPerUsdc)
}

function fail(message: string): AmountResult {
  return { ok: false, message }
}
