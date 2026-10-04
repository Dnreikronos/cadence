import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { deriveActivation } from "./activation"
import {
  DuplicateEmailError,
  PeopleStoreError,
  PersonNotFoundError,
} from "./errors"
import type { PeopleRepository } from "./repository"
import { MAX_PEOPLE, readRows } from "./paging"
import { personKinds, type PersonInput, type PersonRecord } from "./types"

// Named, never `select *`: the invites table also holds the token hash.
const personColumns = "id, name, email, kind, status"
const inviteColumns = "person_id, expires_at"

const personRow = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  kind: z.enum(personKinds),
  status: z.enum(["pending", "active", "removed"]),
})
type PersonRow = z.infer<typeof personRow>

const inviteRow = z.object({
  person_id: z.string().nullable(),
  expires_at: z.string(),
})

// Postgres unique_violation: the (company, lower(email)) index.
const uniqueViolation = "23505"

type Failure = { code?: string } | null

// Whatever the store says stays out of the UI.
function check(error: Failure) {
  if (!error) return
  if (error.code === uniqueViolation) throw new DuplicateEmailError()
  throw new PeopleStoreError()
}

function parse<T extends z.ZodType>(schema: T, rows: unknown): z.output<T>[] {
  const parsed = z.array(schema).safeParse(rows)
  if (!parsed.success) throw new PeopleStoreError()
  return parsed.data
}

// Every pending invite has a person, and a company's removed people keep theirs,
// so there can be more invites than listed people.
const MAX_INVITES = 10_000

export function createSupabasePeopleRepository(
  supabase: SupabaseClient,
): PeopleRepository {
  // Keyed on the user: a different admin signing in within one tab must not
  // insert into the previous one's company. A failed lookup is not kept.
  let company: { userId: string; id: Promise<string> } | undefined

  // The admin's own membership names the company the insert belongs to; RLS
  // only accepts the one they administer.
  async function companyId() {
    // The session is read locally; RLS is what decides what the lookup returns.
    const { data: auth, error: authError } = await supabase.auth.getSession()
    const userId = auth.session?.user.id
    if (authError || !userId) throw new PeopleStoreError()
    if (company?.userId === userId) return company.id
    const lookup = (async () => {
      const { data, error } = await supabase
        .from("memberships")
        .select("company_id")
        .eq("user_id", userId)
        .maybeSingle()
      check(error)
      const parsed = z.object({ company_id: z.string() }).safeParse(data)
      // No membership: this account administers no company.
      if (!parsed.success) throw new PeopleStoreError()
      return parsed.data.company_id
    })()
    const entry = { userId, id: lookup }
    company = entry
    lookup.catch(() => {
      if (company === entry) company = undefined
    })
    return lookup
  }

  return {
    async list() {
      const [people, invites] = await Promise.all([
        readRows(async (from, to) => {
          const { data, error } = await supabase
            .from("people")
            .select(personColumns)
            .neq("status", "removed")
            .order("name")
            .order("id")
            .range(from, to)
          check(error)
          return parse(personRow, data)
        }, MAX_PEOPLE),
        readRows(async (from, to) => {
          const { data, error } = await supabase
            .from("invites")
            .select(inviteColumns)
            .eq("role", "recipient")
            .is("accepted_at", null)
            .order("id")
            .range(from, to)
          check(error)
          return parse(inviteRow, data)
        }, MAX_INVITES),
      ])

      const expiry = new Map<string, string>()
      for (const invite of invites.rows) {
        if (invite.person_id) expiry.set(invite.person_id, invite.expires_at)
      }
      const now = Date.now()
      return {
        people: people.rows
          .filter(
            (row): row is PersonRow & { status: "pending" | "active" } =>
              row.status !== "removed",
          )
          .map((row): PersonRecord => ({
            id: row.id,
            name: row.name,
            email: row.email,
            kind: row.kind,
            activation: deriveActivation(
              row.status,
              expiry.get(row.id) ?? null,
              now,
            ),
          })),
        truncated: people.truncated || invites.truncated,
      }
    },

    async create(input: PersonInput) {
      const company_id = await companyId()
      const { data, error } = await supabase
        .from("people")
        .insert({
          company_id,
          name: input.name,
          email: input.email,
          kind: input.kind,
        })
        .select("id")
        .single()
      check(error)
      const parsed = z.object({ id: z.string() }).safeParse(data)
      if (!parsed.success) throw new PeopleStoreError()
      return { id: parsed.data.id }
    },

    async update(id, input) {
      const { data, error } = await supabase
        .from("people")
        .update({ name: input.name, email: input.email, kind: input.kind })
        .eq("id", id)
        .neq("status", "removed")
        .select("id")
      check(error)
      // RLS hides rows from other companies: no row back means no such person.
      if (!data?.length) throw new PersonNotFoundError()
    },

    async remove(id) {
      const { data, error } = await supabase
        .from("people")
        .update({ status: "removed" })
        .eq("id", id)
        .neq("status", "removed")
        .select("id")
      check(error)
      if (!data?.length) throw new PersonNotFoundError()
    },

    // The invite service already wrote the row this list reads.
    async recordInvite() {},
  }
}
