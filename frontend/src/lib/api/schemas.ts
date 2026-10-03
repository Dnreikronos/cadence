import { z } from "zod"

// Written against docs/dev/API_CONTRACT.md. Requests are validated before they
// leave the browser and responses before a screen sees them, so a drift from the
// contract fails in one place with a clear error.

// Integer base units as a decimal string, six decimals (1 USDC = "1000000").
// Never a number: a float cannot hold every amount exactly.
const maxUnits = 2n ** 48n - 1n
export const unitsSchema = z
  .string()
  .regex(/^[1-9]\d{0,14}$/, "Amounts are integer base units")
  .refine((value) => BigInt(value) <= maxUnits, "Amount is past 2^48 - 1")

// Reads can be zero.
const unitsOrZero = z.string().regex(/^(0|[1-9]\d{0,14})$/)

const id = z.guid()
const key = z.string().min(32).max(44)
const timestamp = z.iso.datetime()

// ---- Prepare and confirm ----------------------------------------------------

export const preparedSchema = z.object({
  request_id: z.string().length(64),
  transaction: z.base64(),
  transaction_version: z.union([z.literal(0), z.literal(1)]),
  required_signers: z.array(z.string().min(1)).min(1),
  recent_blockhash: z.string().min(1),
  last_valid_block_height: z.number().int().nonnegative(),
})
export type Prepared = z.infer<typeof preparedSchema>

export const receiptSchema = z.object({
  request_id: z.string().length(64),
  signature: z.string().min(1),
  slot: z.number().int().nonnegative(),
  status: z.literal("finalized"),
})
export type Receipt = z.infer<typeof receiptSchema>

export const confirmRequestSchema = z.object({
  request_id: z.string().length(64),
  signature: z.string().min(1),
})
export type ConfirmRequest = z.infer<typeof confirmRequestSchema>

// ---- Wrap and transfer ------------------------------------------------------

export const wrapRequestSchema = z.object({
  company_wallet: key,
  amount: unitsSchema,
  setup: z
    .object({
      pubkey_validity_proof: z.base64(),
      decryptable_zero_balance: z.base64(),
    })
    .optional(),
})
export type WrapRequest = z.infer<typeof wrapRequestSchema>

export const wrapPreparedSchema = preparedSchema.extend({
  destination: z.string().min(1),
  mint: z.string().min(1),
  deposit_state: z.literal("pending_after_confirmation"),
})
export type WrapPrepared = z.infer<typeof wrapPreparedSchema>

export const transferRequestSchema = z.object({
  company_wallet: key,
  sender: key,
  recipient: key,
  amount: unitsSchema,
  aes_key: z.base64(),
  // Only the first request for a wallet.
  wallet_signature: z.string().min(1).optional(),
})
export type TransferRequest = z.infer<typeof transferRequestSchema>

export const transferPreparedSchema = preparedSchema.extend({
  sender: z.string().min(1),
  destination: z.string().min(1),
  mint: z.string().min(1),
})
export type TransferPrepared = z.infer<typeof transferPreparedSchema>

// ---- Payroll runs -----------------------------------------------------------

export const runRequestSchema = z.object({
  company_wallet: key,
  payments: z
    .array(z.object({ person_id: id, amount: unitsSchema }))
    .min(1)
    .max(200),
  idempotency_key: id,
})
export type RunRequest = z.infer<typeof runRequestSchema>

export const runPaymentPreparedSchema = preparedSchema.extend({
  payment_id: id,
  person_id: id,
})
export type RunPaymentPrepared = z.infer<typeof runPaymentPreparedSchema>

export const runCreatedSchema = z.object({
  run_id: id,
  // In signing order.
  payments: z.array(runPaymentPreparedSchema).min(1),
})
export type RunCreated = z.infer<typeof runCreatedSchema>

export const paymentStatuses = [
  "pending",
  "signed",
  "confirmed",
  "failed",
  "expired",
] as const
export type PaymentStatus = (typeof paymentStatuses)[number]

export const runSchema = z.object({
  run_id: id,
  created_at: timestamp,
  payments: z.array(
    z.object({
      payment_id: id,
      person_id: id,
      status: z.enum(paymentStatuses),
      transparent: z.boolean(),
      // A stable code when failed, never a message with values.
      failure: z.string().nullable(),
      signature: z.string().nullable(),
    }),
  ),
})
export type Run = z.infer<typeof runSchema>

export const paymentConfirmSchema = z.object({ signature: z.string().min(1) })

// ---- Unwrap -----------------------------------------------------------------

export const unwrapRequestSchema = z.object({
  wallet: key,
  amount: unitsSchema,
  acknowledge_reveal_risk: z.boolean(),
})
export type UnwrapRequest = z.infer<typeof unwrapRequestSchema>

export const revealRiskLevels = ["none", "near", "exact"] as const
export type RevealRiskLevel = (typeof revealRiskLevels)[number]

export const unwrapPreparedSchema = preparedSchema.extend({
  reveal_risk: z.object({
    level: z.enum(revealRiskLevels),
    // Payment ids and dates only. Never an amount.
    matches: z.array(z.object({ payment_id: id, paid_at: timestamp })),
  }),
})
export type UnwrapPrepared = z.infer<typeof unwrapPreparedSchema>

// ---- Accounts and keys ------------------------------------------------------

export const walletRequestSchema = z.object({ wallet: key })

export const enrollRequestSchema = z.object({
  wallet: key,
  // Signature of the canonical key-derivation message. Never a key.
  signature: z.string().min(1),
})
export const enrolledSchema = z.object({ status: z.literal("enrolled") })

// ---- Reads ------------------------------------------------------------------

export const balanceSchema = z.object({
  available: unitsOrZero,
  pending: unitsOrZero,
  as_of_slot: z.number().int().nonnegative(),
})
export type Balance = z.infer<typeof balanceSchema>

export const paymentItemSchema = z.object({
  payment_id: id,
  run_id: id.nullable(),
  counterparty: z.object({ id, name: z.string() }),
  amount: unitsSchema,
  status: z.enum(["pending", "confirmed", "failed"]),
  transparent: z.boolean(),
  paid_at: timestamp,
  signature: z.string().nullable(),
})
export type PaymentItem = z.infer<typeof paymentItemSchema>

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
  })
}

export const personAmountSchema = z.object({
  person_id: id,
  amount: unitsSchema,
})
export type PersonAmount = z.infer<typeof personAmountSchema>

export const setAmountRequestSchema = z.object({ amount: unitsSchema })

export const inviteSchema = z.object({
  status: z.literal("sent"),
  expires_at: timestamp,
})

export const healthSchema = z.object({
  status: z.enum(["ok", "unavailable"]),
  build_sha: z.string(),
  rpc_reachable: z.boolean(),
})
export type Health = z.infer<typeof healthSchema>

export const errorBodySchema = z.object({ error: z.string().min(1) })
