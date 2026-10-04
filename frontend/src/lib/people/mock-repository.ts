import { registerPerson, seedPeople } from "@/lib/api/mocks/db"
import { deriveActivation } from "./activation"
import { DuplicateEmailError, PersonNotFoundError } from "./errors"
import type { PeopleRepository } from "./repository"
import type { PersonInput, PersonKind } from "./types"

type Row = {
  id: string
  name: string
  email: string
  kind: PersonKind
  active: boolean
  inviteExpiresAt: string | null
}

const day = 86_400_000

// The same ids as the proof-service mock, so amounts and invites line up. The
// pending ones differ in what they show: Mariana's invite has lapsed.
function seedRows(now: number): Row[] {
  const [bruno, mariana, diego, northwind] = seedPeople
  return [
    {
      id: bruno.id,
      name: bruno.name,
      email: "bruno@solaris.test",
      kind: "employee",
      active: bruno.activated,
      inviteExpiresAt: null,
    },
    {
      id: mariana.id,
      name: mariana.name,
      email: "mariana@solaris.test",
      kind: "employee",
      active: mariana.activated,
      inviteExpiresAt: new Date(now - 2 * day).toISOString(),
    },
    {
      id: diego.id,
      name: diego.name,
      email: "diego@martins.test",
      kind: "contractor",
      active: diego.activated,
      inviteExpiresAt: null,
    },
    {
      id: northwind.id,
      name: northwind.name,
      email: "billing@northwind.test",
      kind: "supplier",
      active: northwind.activated,
      inviteExpiresAt: null,
    },
  ]
}

const delay = (ms = 200) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createMockPeopleRepository(
  now: () => number = Date.now,
  wait: (ms?: number) => Promise<void> = delay,
): PeopleRepository {
  let rows = seedRows(now())
  // Removed people are kept out of sight, like the table keeps the row.
  const removed = new Set<string>()
  const visible = () => rows.filter((row) => !removed.has(row.id))

  const find = (id: string) => {
    const row = visible().find((candidate) => candidate.id === id)
    if (!row) throw new PersonNotFoundError()
    return row
  }
  const assertFree = (email: string, exceptId?: string) => {
    const taken = rows.some(
      (row) =>
        row.id !== exceptId && row.email.toLowerCase() === email.toLowerCase(),
    )
    if (taken) throw new DuplicateEmailError()
  }

  return {
    async list() {
      await wait()
      return visible()
        .map((row) => ({
          id: row.id,
          name: row.name,
          email: row.email,
          kind: row.kind,
          activation: deriveActivation(
            row.active ? "active" : "pending",
            row.inviteExpiresAt,
            now(),
          ),
        }))
        .sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        )
    },
    async create(input: PersonInput) {
      await wait()
      assertFree(input.email)
      const id = crypto.randomUUID()
      rows = [...rows, { ...input, id, active: false, inviteExpiresAt: null }]
      // The proof service only accepts people that exist.
      registerPerson(id)
      return { id }
    },
    async update(id, input) {
      await wait()
      find(id)
      assertFree(input.email, id)
      // Like the table, the pending invite stays: the invite service replaces
      // it on the next send, so the UI asks for one.
      rows = rows.map((row) => (row.id === id ? { ...row, ...input } : row))
    },
    async remove(id) {
      await wait()
      find(id)
      removed.add(id)
    },
    async recordInvite(personId, expiresAt) {
      const row = find(personId)
      rows = rows.map((candidate) =>
        candidate.id === row.id
          ? { ...candidate, inviteExpiresAt: expiresAt }
          : candidate,
      )
    },
  }
}

let shared: PeopleRepository | undefined

// One list per tab, like the mock proof service: a reload starts over.
export function mockPeopleRepository() {
  return (shared ??= createMockPeopleRepository())
}
