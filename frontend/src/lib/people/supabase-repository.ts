import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { deriveActivation } from "./activation"
import {
  DuplicateEmailError,
  PeopleStoreError,
  PersonNotFoundError,
} from "./errors"
import type { PeopleRepository } from "./repository"
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

export function createSupabasePeopleRepository(
  supabase: SupabaseClient,
): PeopleRepository {
  let company: Promise<string> | undefined

  // The admin's own membership names the company the insert belongs to; RLS
  // only accepts the one they administer.
  function companyId() {
    company ??= (async () => {
      const { data: auth, error: authError } = await supabase.auth.getUser()
      if (authError || !auth.user) throw new PeopleStoreError()
      const { data, error } = await supabase
        .from("memberships")
        .select("company_id")
        .eq("user_id", auth.user.id)
        .maybeSingle()
      check(error)
      const parsed = z.object({ company_id: z.string() }).safeParse(data)
      if (!parsed.success) throw new PeopleStoreError()
      return parsed.data.company_id
    })().catch((error: unknown) => {
      company = undefined
      throw error
    })
    return company
  }

  return {
    async list() {
      const [people, invites] = await Promise.all([
        supabase
          .from("people")
          .select(personColumns)
          .neq("status", "removed")
          .order("name")
          .order("id"),
        supabase
          .from("invites")
          .select(inviteColumns)
          .eq("role", "recipient")
          .is("accepted_at", null),
      ])
      check(people.error)
      check(invites.error)

      const expiry = new Map<string, string>()
      for (const invite of parse(inviteRow, invites.data)) {
        if (invite.person_id) expiry.set(invite.person_id, invite.expires_at)
      }
      const now = Date.now()
      return parse(personRow, people.data)
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
        }))
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
