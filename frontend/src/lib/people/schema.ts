import { z } from "zod"
import { personKinds } from "./types"

// Mirrors the people table checks, plus the 2^48-1 base-unit ceiling on amounts.
const maxAmount = (2 ** 48 - 1) / 1_000_000

export const personSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name")
    .max(200, "Keep the name under 200 characters"),
  email: z
    .string()
    .trim()
    .max(320, "That email is too long")
    .regex(/^[^@\s]+@[^@\s]+$/, "Enter a valid email address"),
  kind: z.enum(personKinds),
  monthlyAmount: z
    .number("Enter a monthly amount")
    .positive("The amount must be more than zero")
    .max(maxAmount, "That amount is too large")
    .refine(
      (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
      "Use at most two decimal places",
    ),
})

// Dollars to base units. Exact: the schema allows two decimals at most, so the
// cents are a whole number and the units are cents times 10,000.
export function dollarsToUnits(dollars: number): string {
  return (BigInt(Math.round(dollars * 100)) * 10_000n).toString()
}

// Amount aside, for an edit whose current amount is not known.
export const personFieldsSchema = personSchema.omit({ monthlyAmount: true })
