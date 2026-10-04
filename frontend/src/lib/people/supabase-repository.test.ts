import type { SupabaseClient } from "@supabase/supabase-js"
import { describe, expect, it } from "vitest"
import {
  DuplicateEmailError,
  PeopleStoreError,
  PersonNotFoundError,
} from "./errors"
import { MAX_PEOPLE } from "./paging"
import { createSupabasePeopleRepository } from "./supabase-repository"

type Result = { data: unknown; error: { code?: string } | null }
type Call = { table: string; steps: [string, unknown[]][] }

// A stand-in for the query builder: it records the chain and answers from
// `answer` when awaited, the way the real one resolves a built query.
function fakeClient(
  answer: (call: Call) => Result,
  session:
    | { user: { id: string } }
    | null
    | (() => { user: { id: string } } | null) = {
    user: { id: "user-1" },
  },
) {
  const calls: Call[] = []
  const client = {
    auth: {
      getSession: async () => {
        const current = typeof session === "function" ? session() : session
        return {
          data: { session: current },
          error: null,
        }
      },
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
        "range",
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
const failure = (code = "XX000"): Result => ({ data: null, error: { code } })

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

// The rows of a table between `from` and `to`, as `.range()` would return them.
function rangeOf(call: Call, all: unknown[]) {
  const [from, to] = stepOf(call, "range") as [number, number]
  return ok(all.slice(from, to + 1))
}

const manyPeople = (count: number) =>
  Array.from({ length: count }, (_, index) => row({ id: `p${index}` }))

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
    const { people, truncated } =
      await createSupabasePeopleRepository(client).list()
    expect(people.map((p) => [p.id, p.activation])).toEqual([
      ["a", "active"],
      ["b", "invited"],
      ["c", "invite-expired"],
      ["d", "not-invited"],
    ])
    expect(truncated).toBe(false)
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
    const { people } = await createSupabasePeopleRepository(client).list()
    expect(people.map((p) => p.id)).toEqual(["here"])
  })

  it("ignores an invite with no person, such as an auditor's", async () => {
    const { client } = fakeClient(({ table }) =>
      table === "people"
        ? ok([row()])
        : ok([{ person_id: null, expires_at: future }]),
    )
    const { people } = await createSupabasePeopleRepository(client).list()
    expect(people[0].activation).toBe("not-invited")
  })

  it("fails with a generic error when either table cannot be read", async () => {
    for (const failing of ["people", "invites"]) {
      const { client } = fakeClient(({ table }) =>
        table === failing ? failure() : ok([]),
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

  it("reads past PostgREST's row cap by ranges, in a stable order", async () => {
    const all = manyPeople(1200)
    const { client, calls } = fakeClient((call) =>
      call.table === "people" ? rangeOf(call, all) : ok([]),
    )
    const { people, truncated } =
      await createSupabasePeopleRepository(client).list()
    expect(people).toHaveLength(1200)
    expect(new Set(people.map((p) => p.id)).size).toBe(1200)
    expect(truncated).toBe(false)
    const reads = calls.filter((call) => call.table === "people")
    expect(reads.length).toBeGreaterThan(1)
    for (const call of reads) {
      expect(call.steps.filter(([name]) => name === "order")).toEqual([
        ["order", ["name"]],
        ["order", ["id"]],
      ])
    }
  })

  it("says the list is partial when more than the limit exist", async () => {
    const all = manyPeople(MAX_PEOPLE + 1)
    const { client } = fakeClient((call) =>
      call.table === "people" ? rangeOf(call, all) : ok([]),
    )
    const { people, truncated } =
      await createSupabasePeopleRepository(client).list()
    expect(people).toHaveLength(MAX_PEOPLE)
    expect(truncated).toBe(true)
  })

  it("does not call the list partial when it has exactly the limit", async () => {
    const all = manyPeople(MAX_PEOPLE)
    const { client } = fakeClient((call) =>
      call.table === "people" ? rangeOf(call, all) : ok([]),
    )
    const { people, truncated } =
      await createSupabasePeopleRepository(client).list()
    expect(people).toHaveLength(MAX_PEOPLE)
    expect(truncated).toBe(false)
  })

  it("pages the invites too, so a late one still marks its person invited", async () => {
    const invites = Array.from({ length: 1100 }, (_, index) => ({
      person_id: index === 1099 ? "p0" : `other${index}`,
      expires_at: future,
    }))
    const { client } = fakeClient((call) =>
      call.table === "people"
        ? ok([row({ id: "p0" })])
        : rangeOf(call, invites),
    )
    const { people } = await createSupabasePeopleRepository(client).list()
    expect(people[0].activation).toBe("invited")
  })
})

describe("supabase people repository: writes", () => {
  const input = {
    name: "Aline",
    email: "aline@prado.test",
    kind: "contractor",
  } as const

  const answerCreate =
    (companyId = "co-1") =>
    ({ table }: Call): Result =>
      table === "memberships"
        ? ok({ company_id: companyId })
        : ok({ id: "new" })

  it("inserts into the admin's company and returns the new id", async () => {
    const { client, calls } = fakeClient(answerCreate())
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

  it("looks the company up once per user", async () => {
    const { client, calls } = fakeClient(answerCreate())
    const repository = createSupabasePeopleRepository(client)
    await repository.create(input)
    await repository.create({ ...input, email: "b@prado.test" })
    expect(calls.filter((c) => c.table === "memberships")).toHaveLength(1)
  })

  it("looks the company up again for a different user in the same tab", async () => {
    let user = "admin-a"
    const { client, calls } = fakeClient(
      ({ table, steps }) => {
        if (table !== "memberships") return ok({ id: "new" })
        const [, args] = steps.find(([name]) => name === "eq")!
        const userId = args[1]
        return ok({ company_id: userId === "admin-a" ? "co-a" : "co-b" })
      },
      () => ({ user: { id: user } }),
    )
    const repository = createSupabasePeopleRepository(client)
    await repository.create(input)
    user = "admin-b"
    await repository.create({ ...input, email: "b@prado.test" })
    const inserts = calls
      .filter((call) => call.table === "people")
      .map((call) => (stepOf(call, "insert") as { company_id: string }[])[0])
    expect(inserts.map((insert) => insert.company_id)).toEqual(["co-a", "co-b"])
  })

  it("does not insert for an account with no membership", async () => {
    const { client, calls } = fakeClient(({ table }) =>
      table === "memberships" ? ok(null) : ok({ id: "new" }),
    )
    await expect(
      createSupabasePeopleRepository(client).create(input),
    ).rejects.toBeInstanceOf(PeopleStoreError)
    expect(calls.some((call) => call.table === "people")).toBe(false)
  })

  it("asks again after a failed company lookup instead of keeping the failure", async () => {
    let lookups = 0
    const { client, calls } = fakeClient(({ table }) => {
      if (table !== "memberships") return ok({ id: "new" })
      lookups += 1
      return lookups === 1 ? failure() : ok({ company_id: "co-1" })
    })
    const repository = createSupabasePeopleRepository(client)
    await expect(repository.create(input)).rejects.toBeInstanceOf(
      PeopleStoreError,
    )
    await expect(repository.create(input)).resolves.toEqual({ id: "new" })
    expect(lookups).toBe(2)
    expect(calls.filter((call) => call.table === "people")).toHaveLength(1)
  })

  it("never writes an amount, however the input is shaped", async () => {
    const { client, calls } = fakeClient(answerCreate())
    await createSupabasePeopleRepository(client).create({
      ...input,
      monthlyAmount: 4200,
    } as typeof input)
    const written = JSON.stringify(calls.map((call) => call.steps))
    expect(written).not.toMatch(/4200|amount/i)
  })

  it("maps a unique violation on create to a duplicate email", async () => {
    const { client } = fakeClient(({ table }) =>
      table === "memberships" ? ok({ company_id: "co-1" }) : failure("23505"),
    )
    await expect(
      createSupabasePeopleRepository(client).create(input),
    ).rejects.toBeInstanceOf(DuplicateEmailError)
  })

  it("maps a unique violation on update to a duplicate email", async () => {
    const { client } = fakeClient(() => failure("23505"))
    await expect(
      createSupabasePeopleRepository(client).update("p1", input),
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
    const { client } = fakeClient(() => failure("42501"))
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
