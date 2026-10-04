import { z } from "zod"

// A transaction the person signed and sent (or is about to), kept so a screen can
// find out what became of it after a reload or a visit elsewhere. Nothing here
// is secret: ids, a signature, a block height and a wallet address.
export const submissionSchema = z.object({
  kind: z.string().min(1),
  request_id: z.string().min(1),
  // Null between the moment of submitting and the node returning one: the
  // transaction may have been accepted all the same.
  signature: z.string().min(1).nullable(),
  last_valid_block_height: z.number().int().nonnegative(),
  wallet: z.string().min(1),
  // Epoch milliseconds when it was sent, for deciding it can no longer land.
  at: z.number().int().nonnegative(),
  // Deposits only: base units that were already pending when it started ("0" for none),
  // so a deposit picked up after a reload can still say what applying the credit covers.
  // Absent in a record written before this existed, or when it was not known.
  earlier_pending: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
})
export type Submission = z.infer<typeof submissionSchema>

export type SubmissionStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>

const keyOf = (kind: string) => `cadence:submission:${kind}`

// Storage can be missing or throw (private windows, blocked site data, server
// render), and a screen has to work without it.
function defaultStorage(): SubmissionStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
  } catch {
    return null
  }
}

// One record per kind of flow: a new one replaces the last.
export function recordSubmission(
  record: Omit<Submission, "at"> & { at?: number },
  storage: SubmissionStorage | null = defaultStorage(),
): Submission {
  const full = { ...record, at: record.at ?? Date.now() }
  try {
    storage?.setItem(keyOf(record.kind), JSON.stringify(full))
  } catch {
    // Without storage the flow still runs; it just cannot be picked up later.
  }
  return full
}

// The record for `kind`, or null when there is none, storage is unavailable, or
// what is stored is not a record (it is removed then).
export function readSubmission(
  kind: string,
  storage: SubmissionStorage | null = defaultStorage(),
): Submission | null {
  try {
    const raw = storage?.getItem(keyOf(kind))
    if (!raw) return null
    const parsed = submissionSchema.safeParse(JSON.parse(raw))
    if (parsed.success && parsed.data.kind === kind) return parsed.data
    storage?.removeItem(keyOf(kind))
  } catch {
    // Unreadable or not JSON.
    try {
      storage?.removeItem(keyOf(kind))
    } catch {
      // Nothing to remove.
    }
  }
  return null
}

export function clearSubmission(
  kind: string,
  storage: SubmissionStorage | null = defaultStorage(),
) {
  try {
    storage?.removeItem(keyOf(kind))
  } catch {
    // Nothing to clear.
  }
}
