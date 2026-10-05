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

// ---- Is anything durable? ----------------------------------------------------

const probeKey = "cadence:probe"
// Storages that passed the probe, and ones whose last real write failed since.
const passed = new WeakSet<object>()
const writeFailed = new WeakSet<object>()
let probes = 0

// Whether a record written now would be there after a reload: writes a sentinel, reads
// it back and removes it. A pass is remembered for this page load, and forgotten when a
// real write fails (`noteWriteFailure`), so a storage that fills up or is blocked later
// is found out; a failure is never remembered, so enabling storage is noticed at once.
export function persisted(
  storage: SubmissionStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false
  if (passed.has(storage) && !writeFailed.has(storage)) return true
  try {
    const sentinel = `${Date.now()}:${++probes}`
    storage.setItem(probeKey, sentinel)
    const ok = storage.getItem(probeKey) === sentinel
    storage.removeItem(probeKey)
    if (ok) {
      passed.add(storage)
      writeFailed.delete(storage)
    } else {
      passed.delete(storage)
    }
    return ok
  } catch {
    passed.delete(storage)
    return false
  }
}

// A real write was refused: the next `persisted()` looks again.
export function noteWriteFailure(storage: SubmissionStorage | null) {
  if (!storage) return
  passed.delete(storage)
  writeFailed.add(storage)
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
    // The flow decides whether it may go on without a record (`persisted()` says): it
    // does in the mock, never in real mode.
    noteWriteFailure(storage)
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

// Who the records belong to: the company by its id (a rename must not orphan them) and
// the email. `company` is the name the screens show and the balance keys use; records
// made under it before ids were used are read once and moved (`legacyScopes`).
export type Viewer = { company: string; email: string; companyId?: string }

export const viewerScopeId = (viewer: Viewer) =>
  stableHash(viewer.companyId ?? viewer.company, viewer.email)

export const legacyViewerScopeIds = (viewer: Viewer): string[] =>
  viewer.companyId && viewer.companyId !== viewer.company
    ? [stableHash(viewer.company, viewer.email)]
    : []

export type RecordList<T> = {
  // The records now: the same array until something changes, so a React store can
  // read it on every render.
  read: () => readonly T[]
  // Adds the record, or replaces the one `same` matches. True when it was written to
  // storage; false when it is only held in memory (no storage, or it refused).
  upsert: (record: T) => boolean
  // Drops every record `match` accepts.
  remove: (match: (record: T) => boolean) => void
  // Saved entries that could not be read were set aside, not dropped: until they are
  // released the whole list must be treated as held.
  unreadable: () => boolean
  // The person's deliberate release of what could not be read.
  clearUnreadable: () => void
  subscribe: (listener: () => void) => () => void
}

type ListOptions<T> = {
  // One storage key per kind and scope.
  kind: string
  scope: string
  // Scopes an earlier version used: read once, merged in, then deleted.
  legacyScopes?: readonly string[]
  schema: z.ZodType<T>
  same: (a: T, b: T) => boolean
  storage?: SubmissionStorage | null
}

const listKey = (kind: string, scope: string) =>
  `cadence:submissions:${kind}:${scope}`

// A list of records under one key, for flows that can have several unresolved at once
// (a withdrawal per amount, a payroll payment per payment). Read from storage once, then
// kept here and written through. When storage is missing or refuses, the list still
// works for as long as this object lives, and `upsert` says it did not reach storage.
//
// An entry that cannot be read is never dropped and never erased by a later write: it is
// moved to a key of its own, and `unreadable()` stays true until it is released on
// purpose. Adding an optional field to a record keeps old entries readable; anything
// else makes them unreadable, which fails closed.
export function createRecordList<T>({
  kind,
  scope,
  legacyScopes = [],
  schema,
  same,
  storage = defaultStorage(),
}: ListOptions<T>): RecordList<T> {
  const key = listKey(kind, scope)
  const setAsideKey = `${key}:unreadable`
  const listeners = new Set<() => void>()
  let records: readonly T[] | null = null
  let setAside = false

  const parseList = (raw: string): { valid: T[]; bad: unknown[] } => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { valid: [], bad: [raw] }
    }
    if (!Array.isArray(parsed)) return { valid: [], bad: [raw] }
    const valid: T[] = []
    const bad: unknown[] = []
    for (const entry of parsed) {
      const result = schema.safeParse(entry)
      if (result.success) valid.push(result.data)
      else bad.push(entry)
    }
    return { valid, bad }
  }

  function keepAside(bad: unknown[]) {
    if (bad.length === 0) return
    setAside = true
    try {
      const earlier = storage?.getItem(setAsideKey)
      const before: unknown = earlier ? JSON.parse(earlier) : []
      storage?.setItem(
        setAsideKey,
        JSON.stringify([...(Array.isArray(before) ? before : []), ...bad]),
      )
    } catch {
      // Held in memory: `setAside` stays true for this page.
    }
  }

  function load(): readonly T[] {
    let valid: T[] = []
    let rewrite = false
    try {
      const raw = storage?.getItem(key)
      if (raw) {
        const found = parseList(raw)
        valid = found.valid
        keepAside(found.bad)
        rewrite = found.bad.length > 0
      }
      for (const legacy of legacyScopes) {
        const oldKey = listKey(kind, legacy)
        const oldRaw = storage?.getItem(oldKey)
        if (!oldRaw) continue
        const found = parseList(oldRaw)
        for (const record of found.valid) {
          if (!valid.some((existing) => same(existing, record))) {
            valid.push(record)
          }
        }
        keepAside(found.bad)
        rewrite = true
        if (valid.length > 0) storage?.setItem(key, JSON.stringify(valid))
        storage?.removeItem(oldKey)
      }
      if (rewrite) {
        if (valid.length === 0) storage?.removeItem(key)
        else storage?.setItem(key, JSON.stringify(valid))
      }
      if (!setAside && storage?.getItem(setAsideKey)) setAside = true
    } catch {
      // Storage refused: what was read so far stands.
    }
    return valid
  }

  function commit(next: readonly T[]): boolean {
    records = next
    let stored = storage != null
    try {
      if (next.length === 0) storage?.removeItem(key)
      else storage?.setItem(key, JSON.stringify(next))
    } catch {
      stored = false
      noteWriteFailure(storage)
    }
    for (const listener of listeners) listener()
    return stored
  }

  const read = () => (records ??= load())

  return {
    read,
    upsert(record) {
      const current = read()
      const at = current.findIndex((existing) => same(existing, record))
      return commit(
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
    unreadable() {
      read()
      return setAside
    },
    clearUnreadable() {
      read()
      setAside = false
      try {
        storage?.removeItem(setAsideKey)
      } catch {
        // Nothing to remove.
      }
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
