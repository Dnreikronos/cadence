import { z } from "zod"

// Written against docs/dev/API_CONTRACT.md. Requests are validated before they
// leave the browser and responses before a screen sees them, so a drift from the
// contract fails in one place with a clear error.

// Integer base units as a decimal string, six decimals (1 USDC = "1000000").
// Never a number: a float cannot hold every amount exactly.
const maxUnits = 2n ** 48n - 1n
// One refine, regex first: BigInt must never see a string it cannot parse, or it
// throws a SyntaxError that echoes the amount.
export const unitsSchema = z
  .string()
  .refine(
    (value) => /^[1-9][0-9]{0,14}$/.test(value) && BigInt(value) <= maxUnits,
    "Amounts are integer base units from 1 to 2^48 - 1",
  )

// Reads can be zero.
const unitsOrZero = z.string().regex(/^(0|[1-9][0-9]{0,14})$/)

export const idSchema = z.guid()
const id = idSchema
// PostgREST and chrono both emit "+00:00" as well as "Z".
const timestamp = z.iso.datetime({ offset: true })

// What the service enforces on requests. Responses stay lenient, except that a
// request id is always 64 lowercase hex characters.
const base58 = /^[1-9A-HJ-NP-Za-km-z]+$/
export const requestIdSchema = z.string().regex(/^[0-9a-f]{64}$/)
const key = z.string().regex(base58).min(32).max(44)
export const signatureSchema = z.string().regex(base58).min(43).max(88)
// 16 bytes: 22 characters, a last one whose low four bits are zero, and "==".
const aesKey = z.string().regex(/^[A-Za-z0-9+/]{21}[AQgw]==$/)

// ---- Prepare and confirm ----------------------------------------------------

export const preparedSchema = z.object({
  request_id: requestIdSchema,
  transaction: z.base64(),
  transaction_version: z.union([z.literal(0), z.literal(1)]),
  required_signers: z.array(z.string().min(1)).min(1),
  recent_blockhash: z.string().min(1),
  last_valid_block_height: z.number().int().nonnegative(),
})
export type Prepared = z.infer<typeof preparedSchema>

export const receiptSchema = z.object({
  request_id: requestIdSchema,
  signature: z.string().min(1),
  slot: z.number().int().nonnegative(),
  status: z.literal("finalized"),
})
export type Receipt = z.infer<typeof receiptSchema>

export const confirmRequestSchema = z.strictObject({
  request_id: requestIdSchema,
  signature: signatureSchema,
})
export type ConfirmRequest = z.infer<typeof confirmRequestSchema>

// ---- Wrap and transfer ------------------------------------------------------

export const wrapRequestSchema = z.strictObject({
  company_wallet: key,
  amount: unitsSchema,
  setup: z
    .strictObject({
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

export const transferRequestSchema = z.strictObject({
  company_wallet: key,
  sender: key,
  recipient: key,
  amount: unitsSchema,
  aes_key: aesKey,
  // Only the first request for a wallet.
  wallet_signature: signatureSchema.optional(),
})
export type TransferRequest = z.infer<typeof transferRequestSchema>

export const transferPreparedSchema = preparedSchema.extend({
  sender: z.string().min(1),
  destination: z.string().min(1),
  mint: z.string().min(1),
})
export type TransferPrepared = z.infer<typeof transferPreparedSchema>

// The known values, which stay in the type for autocompletion, and any other
// string, so a value added later is not a ContractError (additive-only).
type Open<T extends string> = T | (string & Record<never, never>)
function open<const T extends readonly [string, ...string[]]>(values: T) {
  return z.union([
    z.enum(values),
    z.string().min(1) as z.ZodType<Open<T[number]>>,
  ])
}

// ---- Payroll runs -----------------------------------------------------------

// docs/dev/RUNS_API.md (#107). Recipients and the sender are token accounts, not people
// or wallets. A run never carries a person or an amount: the client knows who each
// `position` is from the request it built (the index in `payments`).
export const runRequestSchema = z.strictObject({
  company_wallet: key,
  // The company's source token account.
  sender: key,
  aes_key: aesKey,
  // Only the first request for a wallet (`wallet_link_required` otherwise).
  wallet_signature: signatureSchema.optional(),
  payments: z
    .array(z.strictObject({ recipient: key, amount: unitsSchema }))
    .min(1)
    // The service takes at most 100 payments, in a 32 KiB body.
    .max(100),
})
export type RunRequest = z.infer<typeof runRequestSchema>

export const runPaymentStatuses = [
  "prepared",
  "finalized",
  "failed",
  "expired",
  "preparation_failed",
] as const
export type RunPaymentStatus = (typeof runPaymentStatuses)[number]

export function isKnownRunPaymentStatus(
  status: string,
): status is RunPaymentStatus {
  return (runPaymentStatuses as readonly string[]).includes(status)
}

export const runStatuses = ["prepared", "partial_failure", "completed"] as const

const runPaymentSchema = z.object({
  position: z.number().int().nonnegative(),
  destination: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  request_id: requestIdSchema.nullable(),
  status: open(runPaymentStatuses),
  signature: z.string().min(1).nullable(),
  slot: z.number().int().nonnegative().nullable(),
  // A stable code, never a message with values.
  error: z.string().min(1).nullable(),
  // Only on prepare and retry, and only for a position prepared in that call.
  transaction: z.base64().optional(),
  last_valid_block_height: z.number().int().nonnegative().optional(),
})
export type RunPayment = z.infer<typeof runPaymentSchema>

// A position whose transaction was not received cannot be signed, whatever its status.
export type RunPaymentPrepared = RunPayment & {
  request_id: string
  transaction: string
  last_valid_block_height: number
}

export const isSignable = (
  payment: RunPayment,
): payment is RunPaymentPrepared =>
  payment.status === "prepared" &&
  payment.request_id !== null &&
  payment.transaction !== undefined &&
  payment.last_valid_block_height !== undefined

// Problems with single positions, in a 200: the rest of the call still counts.
const runItemErrorSchema = z.object({
  position: z.number().int().nonnegative(),
  error: z.string().min(1),
})
export type RunItemError = z.infer<typeof runItemErrorSchema>

export const runSchema = z.object({
  run_id: id,
  company_wallet: z.string().min(1),
  sender: z.string().min(1),
  mint: z.string().min(1),
  transaction_version: z.literal(1),
  required_signers: z.array(z.string().min(1)).min(1),
  status: open(runStatuses),
  // In signing order.
  payments: z.array(runPaymentSchema),
  errors: z.array(runItemErrorSchema).optional(),
})
export type Run = z.infer<typeof runSchema>

export const runConfirmRequestSchema = z.strictObject({
  payments: z
    .array(
      z.strictObject({
        position: z.number().int().nonnegative(),
        request_id: requestIdSchema,
        signature: signatureSchema,
      }),
    )
    .min(1)
    .max(100),
})
export type RunConfirmRequest = z.infer<typeof runConfirmRequestSchema>

export const runRetryRequestSchema = z.strictObject({
  aes_key: aesKey,
  payments: z
    .array(
      z.strictObject({
        position: z.number().int().nonnegative(),
        amount: unitsSchema,
        // The original signature of a prepared position that is still live.
        signature: signatureSchema.optional(),
      }),
    )
    .min(1)
    .max(100),
})
export type RunRetryRequest = z.infer<typeof runRetryRequestSchema>

// Where a person's private payments go (proposed, API_CONTRACT Q36): null until they
// have configured an account.
export const recipientAccountSchema = z.object({
  person_id: id,
  token_account: z.string().min(1).nullable(),
})
export type RecipientAccount = z.infer<typeof recipientAccountSchema>

// ---- Unwrap -----------------------------------------------------------------

export const unwrapRequestSchema = z.strictObject({
  wallet: key,
  amount: unitsSchema,
  acknowledge_reveal_risk: z.boolean(),
})
export type UnwrapRequest = z.infer<typeof unwrapRequestSchema>

export const revealRiskLevels = ["none", "near", "exact"] as const
export type RevealRiskLevel = (typeof revealRiskLevels)[number]

export const unwrapPreparedSchema = preparedSchema.extend({
  reveal_risk: z.object({
    level: z.enum(revealRiskLevels).catch("exact"),
    // Payment ids and dates only. Never an amount.
    matches: z.array(z.object({ payment_id: id, paid_at: timestamp })),
  }),
})
export type UnwrapPrepared = z.infer<typeof unwrapPreparedSchema>

// ---- Accounts and keys ------------------------------------------------------

export const walletRequestSchema = z.strictObject({ wallet: key })

export const enrollRequestSchema = z.strictObject({
  wallet: key,
  // Signature of the canonical key-derivation message. Never a key.
  signature: signatureSchema,
})
export const enrolledSchema = z.object({ status: z.literal("enrolled") })

// ---- Reads ------------------------------------------------------------------

export const balanceSchema = z.object({
  available: unitsOrZero,
  pending: unitsOrZero,
  as_of_slot: z.number().int().nonnegative(),
})
export type Balance = z.infer<typeof balanceSchema>

export const paymentItemStatuses = ["pending", "confirmed", "failed"] as const
export type PaymentItemStatus = (typeof paymentItemStatuses)[number]

// What a screen shows and decides on for a payment in a list. An unknown status is
// pending: never confirmed, never failed, so nothing is claimed or offered for it.
export function knownPaymentStatus(status: string): PaymentItemStatus {
  return (paymentItemStatuses as readonly string[]).includes(status)
    ? (status as PaymentItemStatus)
    : "pending"
}

export const paymentItemSchema = z.object({
  payment_id: id,
  run_id: id.nullable(),
  counterparty: z.object({ id, name: z.string() }),
  amount: unitsSchema,
  status: open(paymentItemStatuses),
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

export const setAmountRequestSchema = z.strictObject({ amount: unitsSchema })

export const inviteSchema = z.object({
  status: z.literal("sent"),
  expires_at: timestamp,
})

// ---- Auditors, access log and account status (proposed, no amounts) ---------

// The rule of the invites table (`20261001000000_tenancy.sql`).
export const emailSchema = z
  .string()
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+$/)

export const auditorStatuses = ["invited", "active", "invite-expired"] as const
export type AuditorStatus = (typeof auditorStatuses)[number]

export function isKnownAuditorStatus(status: string): status is AuditorStatus {
  return (auditorStatuses as readonly string[]).includes(status)
}

// An unknown status is shown as a pending invite: it never claims access.
export function knownAuditorStatus(status: string): AuditorStatus {
  return isKnownAuditorStatus(status) ? status : "invited"
}

export const auditorSchema = z.object({
  id,
  email: z.string().min(1),
  status: open(auditorStatuses),
  invited_at: timestamp,
})
export type Auditor = z.infer<typeof auditorSchema>

export const inviteAuditorRequestSchema = z.strictObject({ email: emailSchema })

export const auditorRevokedSchema = z.object({ status: z.literal("revoked") })

export const accessActorKinds = [
  "service",
  "company",
  "recipient",
  "auditor",
] as const
export const accessActions = [
  "read_payments",
  "read_balance",
  "export_csv",
] as const

export const accessLogItemSchema = z.object({
  id,
  at: timestamp,
  actor: z.object({
    kind: open(accessActorKinds),
    label: z.string(),
  }),
  action: open(accessActions),
  // What was read, in words. Never an amount or a payment id.
  scope: z.string(),
})
export type AccessLogItem = z.infer<typeof accessLogItemSchema>

export const accountStatusSchema = z.object({
  wallet_linked: z.boolean(),
  key_enrolled: z.boolean(),
  account_configured: z.boolean(),
  pending_credits: z.boolean(),
})
export type AccountStatus = z.infer<typeof accountStatusSchema>

export const healthSchema = z.object({
  status: z.enum(["ok", "unavailable"]),
  // A 503 can come without it.
  build_sha: z.string().optional(),
  rpc_reachable: z.boolean(),
})
export type Health = z.infer<typeof healthSchema>

export const errorBodySchema = z.object({ error: z.string().min(1) })
