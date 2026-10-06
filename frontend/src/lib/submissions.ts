import { z } from "zod"

// A transaction the person signed and sent (or is about to), kept so a screen can
// find out what became of it after a reload, a visit elsewhere or another tab. Nothing
// here is secret: ids, a signature, a block height and a wallet address.
//
// The records live in `localStorage`, which every tab of the browser profile shares: a
// second tab must see what the first one holds as "may have gone through", or it could
// send it again. Keys carry the viewer (a hash of company id and email), so one person's
// records are never read as another's. Signing out keeps what may have been sent (the
// next sign-in of the same person must still find it held) and removes only what is
// settled (`clearSettledEvidence`); `pruneEvidence` drops what is old enough to be of no use.
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
> & {
  // Told when ANOTHER tab changes the store (the key, or null when it was cleared): what
  // `localStorage` says with its `storage` event, which never fires in the tab that
  // wrote. Absent where there is no other tab to hear from.
  subscribe?: (listener: (key: string | null) => void) => () => void
  // Every key, for removing a viewer's records or pruning old ones.
  keys?: () => string[]
}

// One record per kind of flow, and per viewer once `scope` is given.
const keyOf = (kind: string, scope?: string) =>
  scope ? `cadence:submission:${kind}:${scope}` : `cadence:submission:${kind}`

// A page's `localStorage` as a `SubmissionStorage`: the same object every time, because
// what `persisted()` remembers is kept per storage object.
let browser: { raw: Storage; view: SubmissionStorage } | null = null

function browserView(raw: Storage): SubmissionStorage {
  return {
    getItem: (key) => raw.getItem(key),
    setItem: (key, value) => raw.setItem(key, value),
    removeItem: (key) => raw.removeItem(key),
    keys: () =>
      Array.from({ length: raw.length }, (_, i) => raw.key(i)).filter(
        (key): key is string => key !== null,
      ),
    subscribe: (listener) => {
      const onStorage = (event: StorageEvent) => {
        if (event.storageArea === raw || event.storageArea === null) {
          listener(event.key)
        }
      }
      window.addEventListener("storage", onStorage)
      return () => window.removeEventListener("storage", onStorage)
    },
  }
}

// Storage can be missing or throw (private windows, blocked site data, server
// render), and a screen has to work without it.
function defaultStorage(): SubmissionStorage | null {
  try {
    if (typeof window === "undefined") return null
    const raw = window.localStorage
    if (browser?.raw !== raw) browser = { raw, view: browserView(raw) }
    return browser.view
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

// One record per kind of flow (and viewer, with a `scope`): a new one replaces the last.
export function recordSubmission(
  record: Omit<Submission, "at"> & { at?: number },
  storage: SubmissionStorage | null = defaultStorage(),
  scope?: string,
): Submission {
  const full = { ...record, at: record.at ?? Date.now() }
  try {
    storage?.setItem(keyOf(record.kind, scope), JSON.stringify(full))
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
  scope?: string,
): Submission | null {
  try {
    const raw = storage?.getItem(keyOf(kind, scope))
    if (!raw) return null
    const parsed = submissionSchema.safeParse(JSON.parse(raw))
    if (parsed.success && parsed.data.kind === kind) return parsed.data
    storage?.removeItem(keyOf(kind, scope))
  } catch {
    // Unreadable or not JSON.
    try {
      storage?.removeItem(keyOf(kind, scope))
    } catch {
      // Nothing to remove.
    }
  }
  return null
}

export function clearSubmission(
  kind: string,
  storage: SubmissionStorage | null = defaultStorage(),
  scope?: string,
) {
  try {
    storage?.removeItem(keyOf(kind, scope))
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
// (a withdrawal per amount, a payroll payment per payment). Storage is the truth: every
// `read()` looks at the stored value and parses it again only when it is not the one
// this object last saw, so a record another tab wrote or removed is seen at once, and
// the same array comes back until something changes (a React store can read it on every
// render). `subscribe` listeners are told when another tab changes the key. When storage
// is missing or refuses, the list still works for as long as this object lives, and
// `upsert` says it did not reach storage.
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
  let stopWatching: (() => void) | undefined
  let records: readonly T[] | null = null
  // The stored value `records` stands for.
  let seen: string | null = null
  // Unreadable entries that could not be written to storage: held for this page only.
  let memoryAside = false

  // What is stored now; undefined when storage cannot be read.
  const peek = (): string | null | undefined => {
    try {
      return storage ? storage.getItem(key) : null
    } catch {
      return undefined
    }
  }

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
    if (!storage) {
      memoryAside = true
      return
    }
    try {
      const earlier = storage.getItem(setAsideKey)
      const before: unknown = earlier ? JSON.parse(earlier) : []
      storage.setItem(
        setAsideKey,
        JSON.stringify([...(Array.isArray(before) ? before : []), ...bad]),
      )
    } catch {
      // Held in memory: `memoryAside` stays true for this page.
      memoryAside = true
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
    seen = peek() ?? seen
    for (const listener of listeners) listener()
    return stored
  }

  // Read, change, write. A synchronous API cannot hold a Web Lock, so the stored value
  // is looked at again right before the write: if another tab wrote since this one read,
  // the change is made again on what that tab left, so its write is not lost. What is left
  // is the gap between two synchronous storage calls.
  function change(mutate: (current: readonly T[]) => readonly T[]): boolean {
    for (let attempt = 0; ; attempt++) {
      const current = read()
      const based = seen
      const next = mutate(current)
      if (next === current) return storage != null
      const now = peek()
      if (attempt < 3 && now !== undefined && now !== based) continue
      return commit(next)
    }
  }

  function read(): readonly T[] {
    if (records === null) {
      records = load()
      seen = peek() ?? null
      return records
    }
    const raw = peek()
    if (raw !== undefined && raw !== seen) {
      records = load()
      seen = peek() ?? raw
    }
    return records
  }

  const asideStored = () => {
    try {
      return !!storage?.getItem(setAsideKey)
    } catch {
      return false
    }
  }

  return {
    read,
    upsert(record) {
      return change((current) => {
        const at = current.findIndex((existing) => same(existing, record))
        return at === -1
          ? [...current, record]
          : current.map((existing, i) => (i === at ? record : existing))
      })
    },
    remove(match) {
      change((current) => {
        const kept = current.filter((record) => !match(record))
        return kept.length === current.length ? current : kept
      })
    },
    unreadable() {
      read()
      return memoryAside || asideStored()
    },
    clearUnreadable() {
      read()
      memoryAside = false
      try {
        storage?.removeItem(setAsideKey)
      } catch {
        // Nothing to remove.
      }
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        stopWatching = storage?.subscribe?.((changed) => {
          if (changed === null || changed === key || changed === setAsideKey) {
            for (const each of [...listeners]) each()
          }
        })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stopWatching?.()
          stopWatching = undefined
        }
      }
    },
  }
}

// ---- One viewer's single records ---------------------------------------------

// The single record of a flow (the deposit's wrap, an apply) for one viewer, in the shape
// the flows take: read, record, clear. Read from storage every time, so another tab's
// record is there as soon as it is written; `subscribe` and `version` are for a screen
// that must notice it (the version is the stored text, which is the same until it changes).
export function submissionStore(
  kind: string,
  viewer: Viewer,
  storage?: SubmissionStorage | null,
) {
  const scope = viewerScopeId(viewer)
  const target = storage === undefined ? defaultStorage() : storage
  const key = keyOf(kind, scope)
  return {
    read: () => readSubmission(kind, target, scope),
    record: (record: Omit<Submission, "at"> & { at?: number }) =>
      recordSubmission(record, target, scope),
    clear: () => clearSubmission(kind, target, scope),
    subscribe: (listener: () => void) =>
      target?.subscribe?.((changed) => {
        if (changed === null || changed === key) listener()
      }) ?? (() => {}),
    version: (): string | null => {
      try {
        return target?.getItem(key) ?? null
      } catch {
        return null
      }
    },
  }
}

// ---- Leaving and tidying -----------------------------------------------------

const evidenceKey = /^cadence:submissions?:[^:]+:([0-9a-f]{16})(:unreadable)?$/

// Rewrites one stored value: `change` gets the text and returns the new text, null to
// remove the key, or undefined to leave it. The value is looked at again right before the
// write, and the change made again if another tab wrote meanwhile (see `change` in the
// record list). Returns whether it wrote.
function rewrite(
  storage: SubmissionStorage,
  key: string,
  change: (raw: string) => string | null | undefined,
): boolean {
  for (let attempt = 0; attempt < 4; attempt++) {
    const raw = storage.getItem(key)
    if (!raw) return false
    const next = change(raw)
    if (next === undefined) return false
    if (storage.getItem(key) !== raw) continue
    if (next === null) storage.removeItem(key)
    else storage.setItem(key, next)
    return true
  }
  return false
}

// What signing out may remove of one viewer's records: only what is settled. A record of
// something that may have been sent stays, so the same person signing back in still finds
// it held (the keys carry the viewer, so no one else reads it). Settled is only a payroll
// attempt list of the shape before #107's runs: runs no longer keep attempts (a run that
// was never signed cannot land), so those lists hold nothing to look into. The set-aside
// unreadable entries are NOT settled: nothing says what they were, so they keep the whole
// list held until the person releases them (behind the two-minute gate and the warning),
// and only that release clears them. Nobody else's are touched.
export function clearSettledEvidence(
  viewer: Viewer,
  storage: SubmissionStorage | null = defaultStorage(),
) {
  if (!storage?.keys) return
  const scopes = new Set([
    viewerScopeId(viewer),
    ...legacyViewerScopeIds(viewer),
  ])
  try {
    for (const key of storage.keys()) {
      const scope = evidenceKey.exec(key)?.[1]
      if (scope === undefined || !scopes.has(scope)) continue
      if (key.includes(":payroll-attempt:") && !key.endsWith(":unreadable")) {
        rewrite(storage, key, () => null)
      }
    }
  } catch {
    // Nothing more can be removed.
  }
}

// Signing out is a request that can fail, and the page stays signed in when it does: so
// what it clears is cleared on the sign-in page it lands on, not before it is sent. The
// person leaving is noted here (this tab's `sessionStorage`) until then.
const leavingKey = "cadence:leaving"
const viewerSchema = z.object({
  email: z.string(),
  company: z.string(),
  companyId: z.string().optional(),
})

function leavingMarker(): Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
  } catch {
    return null
  }
}

export function markLeaving(
  viewer: Viewer,
  marker: Pick<Storage, "setItem"> | null = leavingMarker(),
) {
  try {
    marker?.setItem(
      leavingKey,
      JSON.stringify({
        email: viewer.email,
        company: viewer.company,
        ...(viewer.companyId ? { companyId: viewer.companyId } : {}),
      }),
    )
  } catch {
    // Nothing is noted: what was settled is removed by the next prune instead.
  }
}

// On reaching a sign-in page: clears what is settled for whoever was noted as leaving.
export function finishLeaving(
  storage: SubmissionStorage | null = defaultStorage(),
  marker: Pick<Storage, "getItem" | "removeItem"> | null = leavingMarker(),
) {
  try {
    const raw = marker?.getItem(leavingKey)
    if (!raw) return
    marker?.removeItem(leavingKey)
    const viewer = viewerSchema.safeParse(JSON.parse(raw))
    if (viewer.success) clearSettledEvidence(viewer.data, storage)
  } catch {
    // Nothing noted, or nothing to clear.
  }
}

// How long a record may stay, settled or not. Settled ones are removed as soon as the
// outcome is final; unresolved ones are kept until the person releases them, and past this
// age a transaction can no longer be in doubt (a blockhash lives about 90 seconds), so
// they go too and nothing lives in the browser for ever.
export const evidenceMaxAgeMs = 30 * 24 * 60 * 60 * 1000

const stamp = (entry: unknown): number | null => {
  if (typeof entry !== "object" || entry === null) return null
  const { at, created_at } = entry as Record<string, unknown>
  const time = typeof at === "number" ? at : created_at
  return typeof time === "number" ? time : null
}

// Drops the records older than `maxAgeMs`, for every viewer, once per page load. Entries
// that cannot be dated or read are left as they are: the set-aside ones are released by
// the person, not by the clock. Returns how many records it removed.
export function pruneEvidence(
  now: number = Date.now(),
  storage: SubmissionStorage | null = defaultStorage(),
  maxAgeMs: number = evidenceMaxAgeMs,
): number {
  let removed = 0
  try {
    for (const key of storage?.keys?.() ?? []) {
      if (!evidenceKey.test(key) || key.endsWith(":unreadable")) continue
      const old = (entry: unknown) => {
        const time = stamp(entry)
        return time !== null && now - time > maxAgeMs
      }
      if (!storage) continue
      let count = 0
      rewrite(storage, key, (raw) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return undefined
        }
        if (Array.isArray(parsed)) {
          const kept = parsed.filter((entry) => !old(entry))
          if (kept.length === parsed.length) return undefined
          count = parsed.length - kept.length
          return kept.length === 0 ? null : JSON.stringify(kept)
        }
        if (!old(parsed)) return undefined
        count = 1
        return null
      })
      removed += count
    }
  } catch {
    // Pruning is housekeeping: whatever it could not reach stays.
  }
  return removed
}
