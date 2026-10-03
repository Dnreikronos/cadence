import { z } from "zod"

// A wrap deposit is capped at 2^48-1 base units (six decimals), like transfers.
const maxAmount = (2 ** 48 - 1) / 1_000_000

export function makePrivateSchema(available: number) {
  return z
    .number("Enter an amount")
    .positive("The amount must be more than zero")
    .max(available, "That is more public USDC than you hold")
    .max(maxAmount, "That amount is too large")
    .refine(
      (value) => Math.abs(value * 1e6 - Math.round(value * 1e6)) < 1e-6,
      "Use at most six decimal places",
    )
}

// Empty or unparseable input becomes undefined so zod reports "Enter an amount".
export function parseAmount(input: string): number | undefined {
  const trimmed = input.trim().replace(/,/g, "")
  if (trimmed === "" || !/^\d*\.?\d*$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}
