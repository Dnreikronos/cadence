import type { SupabaseClient } from "@supabase/supabase-js"
import { describe, expect, it } from "vitest"
import {
  DuplicateEmailError,
  PeopleStoreError,
  PersonNotFoundError,
} from "./errors"
import { createSupabasePeopleRepository } from "./supabase-repository"

type Result = { data: unknown; error: { code?: string } | null }
type Call = { table: string; steps: [string, unknown[]][] }

// A stand-in for the query builder: it records the chain and answers from
// `answer` when awaited, the way the real one resolves a built query.
function fakeClient(
  answer: (call: Call) => Result,
  user: { id: string } | null = { id: "user-1" },
) {
  const calls: Call[] = []
  const client = {
    auth: {
      getUser: async () => ({
        data: { user: user },
        error: user ? null : { message: "no session" },
      }),
    },
    from(table: string) {
      const call: Call = { table, steps: [] }
      calls.push(call)
      const builder: Record<string, unknown> = {
        then: (resolve: (value: Result) => unknown) =>
          Promise.resolve(answer(call)).then(resolve),
      }
      for (const method of [
        "select",
        "insert",
        "update",
        "eq",
        "neq",
        "is",
        "order",
        "single",
        "maybeSingle",
      ]) {
        builder[method] = (...args: unknown[]) => {
          call.steps.push([method, args])
          return builder
        }
      }
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

const ok = (data: unknown): Result => ({ data, error: null })

const row = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  name: "Bruno Costa",
  email: "bruno@solaris.test",
  kind: "employee",
  status: "pending",
  ...over,
})

const future = new Date(Date.now() + 86_400_000).toISOString()
const past = new Date(Date.now() - 86_400_000).toISOString()

const stepOf = (call: Call, method: string) =>
  call.steps.find(([name]) => name === method)?.[1]

describe("supabase people repository: list", () => {
  it("derives all four activations from the people and invite rows", async () => {
    const { client } = fakeClient(({ table }) =>
      table === "people"
        ? ok([
            row({ id: "a", status: "active" }),
            row({ id: "b" }),
            row({ id: "c" }),
            row({ id: "d" }),
          ])
        : ok([
            { person_id: "b", expires_at: future },
            { person_id: "c", expires_at: past },
          ]),
    )
    const people = await createSupabasePeopleRepository(client).list()
    expect(people.map((p) => [p.id, p.activation])).toEqual([
      ["a", "active"],
      ["b", "invited"],
      ["c", "invite-expired"],
      ["d", "not-invited"],
    ])
  })

  it("reads pending recipient invites with named columns, never select *", async () => {
    const { client, calls } = fakeClient(() => ok([]))
    await createSupabasePeopleRepository(client).list()
    const invites = calls.find((call) => call.table === "invites")!
    const columns = String(stepOf(invites, "select")?.[0])
    expect(columns).toBe("person_id, expires_at")
    expect(columns).not.toMatch(/\*|token/)
    expect(stepOf(invites, "eq")).toEqual(["role", "recipient"])
    expect(stepOf(invites, "is")).toEqual(["accepted_at", null])
    const people = calls.find((call) => call.table === "people")!
    expect(String(stepOf(people, "select")?.[0])).not.toMatch(/\*/)
    expect(stepOf(people, "neq")).toEqual(["status", "removed"])
  })

  it("does not list a removed person, even if the filter let one through", async () => {
    const { client } = fakeClient(({ table }) =>
      table === "people"
        ? ok([row({ id: "gone", status: "removed" }), row({ id: "here" })])
        : ok([]),
    )
    const people = await createSupabasePeopleRepository(client).list()
    expect(people.map((p) => p.id)).toEqual(["here"])
  })

  it("ignores an invite with no person, such as an auditor's", async () => {
    const { client } = fakeClient(({ table }) =>
      table === "people"
        ? ok([row()])
        : ok([{ person_id: null, expires_at: future }]),
    )
    const people = await createSupabasePeopleRepository(client).list()
    expect(people[0].activation).toBe("not-invited")
  })

  it("fails with a generic error when either table cannot be read", async () => {
    for (const failing of ["people", "invites"]) {
      const { client } = fakeClient(({ table }) =>
        table === failing ? { data: null, error: { code: "XX000" } } : ok([]),
      )
      await expect(
        createSupabasePeopleRepository(client).list(),
      ).rejects.toBeInstanceOf(PeopleStoreError)
    }
  })

  it("fails on a row that does not match the table's shape", async () => {
    const { client } = fakeClient(({ table }) =>
      table === "people" ? ok([row({ kind: "partner" })]) : ok([]),
    )
    await expect(
      createSupabasePeopleRepository(client).list(),
    ).rejects.toBeInstanceOf(PeopleStoreError)
  })
})

describe("supabase people repository: writes", () => {
  const input = {
    name: "Aline",
    email: "aline@prado.test",
    kind: "contractor",
  } as const

  it("inserts into the admin's company and returns the new id", async () => {
    const { client, calls } = fakeClient(({ table }) =>
      table === "memberships" ? ok({ company_id: "co-1" }) : ok({ id: "new" }),
    )
    const created = await createSupabasePeopleRepository(client).create(input)
    expect(created).toEqual({ id: "new" })
    const insert = calls.find((call) => call.table === "people")!
    expect(stepOf(insert, "insert")).toEqual([
      {
        company_id: "co-1",
        name: "Aline",
        email: "aline@prado.test",
        kind: "contractor",
      },
    ])
    const membership = calls.find((call) => call.table === "memberships")!
    expect(stepOf(membership, "eq")).toEqual(["user_id", "user-1"])
  })

  it("looks the company up once", async () => {
    const { client, calls } = fakeClient(({ table }) =>
      table === "memberships" ? ok({ company_id: "co-1" }) : ok({ id: "new" }),
    )
    const repository = createSupabasePeopleRepository(client)
    await repository.create(input)
    await repository.create({ ...input, email: "b@prado.test" })
    expect(calls.filter((c) => c.table === "memberships")).toHaveLength(1)
  })

  it("never writes an amount, however the input is shaped", async () => {
    const { client, calls } = fakeClient(({ table }) =>
      table === "memberships" ? ok({ company_id: "co-1" }) : ok({ id: "new" }),
    )
    await createSupabasePeopleRepository(client).create({
      ...input,
      monthlyAmount: 4200,
    } as typeof input)
    const written = JSON.stringify(calls.map((call) => call.steps))
    expect(written).not.toMatch(/4200|amount/i)
  })

  it("maps a unique violation to a duplicate email", async () => {
    const { client } = fakeClient(({ table }) =>
      table === "memberships"
        ? ok({ company_id: "co-1" })
        : { data: null, error: { code: "23505" } },
    )
    await expect(
      createSupabasePeopleRepository(client).create(input),
    ).rejects.toBeInstanceOf(DuplicateEmailError)
  })

  it("fails without a session instead of inserting for nobody", async () => {
    const { client, calls } = fakeClient(() => ok({}), null)
    await expect(
      createSupabasePeopleRepository(client).create(input),
    ).rejects.toBeInstanceOf(PeopleStoreError)
    expect(calls).toHaveLength(0)
  })

  it("updates only name, email and kind of a person who is not removed", async () => {
    const { client, calls } = fakeClient(() => ok([{ id: "p1" }]))
    await createSupabasePeopleRepository(client).update("p1", input)
    const update = calls[0]
    expect(stepOf(update, "update")).toEqual([
      { name: "Aline", email: "aline@prado.test", kind: "contractor" },
    ])
    expect(stepOf(update, "eq")).toEqual(["id", "p1"])
    expect(stepOf(update, "neq")).toEqual(["status", "removed"])
  })

  it("reports no such person when RLS or removal matched no row", async () => {
    const { client } = fakeClient(() => ok([]))
    const repository = createSupabasePeopleRepository(client)
    await expect(repository.update("p1", input)).rejects.toBeInstanceOf(
      PersonNotFoundError,
    )
    await expect(repository.remove("p1")).rejects.toBeInstanceOf(
      PersonNotFoundError,
    )
  })

  it("removes by setting the status, never by deleting", async () => {
    const { client, calls } = fakeClient(() => ok([{ id: "p1" }]))
    await createSupabasePeopleRepository(client).remove("p1")
    expect(stepOf(calls[0], "update")).toEqual([{ status: "removed" }])
    expect(calls[0].steps.map(([name]) => name)).not.toContain("delete")
  })

  it("hides the store's message when a write fails", async () => {
    const { client } = fakeClient(() => ({
      data: null,
      error: { code: "42501" },
    }))
    await expect(
      createSupabasePeopleRepository(client).remove("p1"),
    ).rejects.toBeInstanceOf(PeopleStoreError)
  })

  it("leaves invites to the invite service", async () => {
    const { client, calls } = fakeClient(() => ok([]))
    await createSupabasePeopleRepository(client).recordInvite("p1", future)
    expect(calls).toHaveLength(0)
  })
})
