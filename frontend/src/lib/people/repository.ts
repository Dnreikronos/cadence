import { apiConfig } from "@/lib/api/mode"
import { isSupabaseConfigured } from "@/lib/supabase/env"
import type { PersonInput, PersonRecord } from "./types"

// The people table. Supabase in production (RLS lets an admin read, insert and
// update their company's rows), an in-memory stand-in in the mock demo.
export interface PeopleRepository {
  // Everyone but the removed, with their activation derived from the invite.
  list(): Promise<PersonRecord[]>
  create(input: PersonInput): Promise<{ id: string }>
  update(id: string, input: PersonInput): Promise<void>
  // Removal is `status = 'removed'` and final: no way back, the row stays.
  remove(id: string): Promise<void>
  // The invite service wrote its own row. Supabase has it already; a mock that
  // keeps its own state needs to be told.
  recordInvite(personId: string, expiresAt: string): Promise<void>
}

let supabase: Promise<PeopleRepository> | undefined

export async function peopleRepository(): Promise<PeopleRepository> {
  if (isSupabaseConfigured()) {
    supabase ??= Promise.all([
      import("./supabase-repository"),
      import("@/lib/supabase/browser"),
    ])
      .then(([repository, browser]) =>
        repository.createSupabasePeopleRepository(browser.browserSupabase()),
      )
      .catch((error: unknown) => {
        supabase = undefined
        throw error
      })
    return supabase
  }
  // The literal check lets Next inline it, so a real-mode build drops the import
  // and the in-memory people never reach the client bundle.
  if (
    process.env.NEXT_PUBLIC_API_MODE !== "real" &&
    apiConfig.mode === "mock"
  ) {
    return (await import("./mock-repository")).mockPeopleRepository()
  }
  throw new Error("Set the Supabase variables to read your people")
}
