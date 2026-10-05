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

// ---- Lists of records, per viewer --------------------------------------------

// A short, stable hash of its parts (FNV-1a, 64 bits, as 16 hex digits). It puts a viewer
// in a storage key, so one person's records are never read as another's on the same tab
// and the key holds no email, and it fingerprints a payroll list. It tells things apart;
// it is not a secret and guards against nothing else.
export function stableHash(...parts: readonly string[]): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(parts.join("\u0000"))) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, "0")
}

// The same viewer the balance keys use: company and email.
export const viewerScopeId = (viewer: { company: string; email: string }) =>
  stableHash(viewer.company, viewer.email)

export type RecordList<T> = {
  // The records now: the same array until something changes, so a React store can
  // read it on every render.
  read: () => readonly T[]
  // Adds the record, or replaces the one `same` matches.
  upsert: (record: T) => void
  // Drops every record `match` accepts.
  remove: (match: (record: T) => boolean) => void
  subscribe: (listener: () => void) => () => void
}

type ListOptions<T> = {
  // One storage key per kind and scope.
  kind: string
  scope: string
  schema: z.ZodType<T>
  same: (a: T, b: T) => boolean
  storage?: SubmissionStorage | null
}

const listKey = (kind: string, scope: string) =>
  `cadence:submissions:${kind}:${scope}`

// A list of records under one key, for flows that can have several unresolved at once
// (a withdrawal per amount, a payroll payment per payment). Read from storage once, then
// kept here and written through. When storage is missing or refuses, the list still
// works for as long as this object lives: a screen behaves as it did before records were
// kept, it just cannot pick them up after a reload. A stored entry that is not a record
// is dropped and the others are kept.
export function createRecordList<T>({
  kind,
  scope,
  schema,
  same,
  storage = defaultStorage(),
}: ListOptions<T>): RecordList<T> {
  const key = listKey(kind, scope)
  const listeners = new Set<() => void>()
  let records: readonly T[] | null = null

  function load(): readonly T[] {
    try {
      const raw = storage?.getItem(key)
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((entry) => {
        const result = schema.safeParse(entry)
        return result.success ? [result.data] : []
      })
    } catch {
      // Unreadable, not JSON, or storage refused.
      return []
    }
  }

  function commit(next: readonly T[]) {
    records = next
    try {
      if (next.length === 0) storage?.removeItem(key)
      else storage?.setItem(key, JSON.stringify(next))
    } catch {
      // Kept in memory only.
    }
    for (const listener of listeners) listener()
  }

  const read = () => (records ??= load())

  return {
    read,
    upsert(record) {
      const current = read()
      const at = current.findIndex((existing) => same(existing, record))
      commit(
        at === -1
          ? [...current, record]
          : current.map((existing, i) => (i === at ? record : existing)),
      )
    },
    remove(match) {
      const current = read()
      const kept = current.filter((record) => !match(record))
      if (kept.length !== current.length) commit(kept)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
