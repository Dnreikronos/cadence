import { describe, expect, it } from "vitest"
import { db, seedPeople } from "@/lib/api/mocks/db"
import { DuplicateEmailError, PersonNotFoundError } from "./errors"
import { createMockPeopleRepository } from "./mock-repository"

const now = Date.parse("2026-10-04T12:00:00Z")

function repository(clock = now) {
  return createMockPeopleRepository(
    () => clock,
    async () => {},
  )
}

const newcomer = {
  name: "Aline Prado",
  email: "aline@prado.test",
  kind: "contractor",
} as const

describe("mock people repository", () => {
  it("is seeded with the proof-service mock's ids, in name order", async () => {
    const people = await repository().list()
    expect(people.map((person) => person.id).sort()).toEqual(
      seedPeople.map((person) => person.id).sort(),
    )
    expect(people.map((person) => person.name)).toEqual(
      [...people.map((person) => person.name)].sort((a, b) =>
        a.localeCompare(b),
      ),
    )
  })

  it("shows every activation the screen has a pill for", async () => {
    const created = repository()
    const before = await created.list()
    const byName = Object.fromEntries(
      before.map((person) => [person.name, person.activation]),
    )
    // Activated in the proof-service mock means active here too.
    expect(byName["Bruno Costa"]).toBe("active")
    expect(byName["Mariana Souza"]).toBe("invite-expired")

    const { id } = await created.create(newcomer)
    expect((await created.list()).find((p) => p.id === id)?.activation).toBe(
      "not-invited",
    )
    await created.recordInvite(id, new Date(now + 86_400_000).toISOString())
    expect((await created.list()).find((p) => p.id === id)?.activation).toBe(
      "invited",
    )
  })

  it("lets the proof service know about a new person", async () => {
    const { id } = await repository().create(newcomer)
    expect(db.people.has(id)).toBe(true)
  })

  it("refuses a second person with the same email, in any case", async () => {
    const created = repository()
    await created.create(newcomer)
    await expect(
      created.create({ ...newcomer, email: "ALINE@prado.test" }),
    ).rejects.toBeInstanceOf(DuplicateEmailError)
  })

  it("allows keeping your own email on an edit but not taking another's", async () => {
    const created = repository()
    const [first, second] = await created.list()
    await created.update(first.id, { ...first, name: "Renamed" })
    await expect(
      created.update(first.id, { ...first, email: second.email }),
    ).rejects.toBeInstanceOf(DuplicateEmailError)
  })

  it("keeps a pending invite when the email changes, like the table does", async () => {
    const created = repository()
    const mariana = (await created.list()).find(
      (p) => p.name === "Mariana Souza",
    )!
    await created.recordInvite(
      mariana.id,
      new Date(now + 86_400_000).toISOString(),
    )
    await created.update(mariana.id, { ...mariana, email: "new@souza.test" })
    const after = (await created.list()).find((p) => p.id === mariana.id)!
    expect(after.email).toBe("new@souza.test")
    expect(after.activation).toBe("invited")
  })

  it("removes a person from the list and for good", async () => {
    const created = repository()
    const [first] = await created.list()
    await created.remove(first.id)
    expect((await created.list()).some((p) => p.id === first.id)).toBe(false)
    await expect(created.remove(first.id)).rejects.toBeInstanceOf(
      PersonNotFoundError,
    )
    await expect(
      created.update(first.id, { ...first, name: "Back" }),
    ).rejects.toBeInstanceOf(PersonNotFoundError)
  })

  it("keeps a removed person's email taken", async () => {
    const created = repository()
    const [first] = await created.list()
    await created.remove(first.id)
    await expect(
      created.create({ ...newcomer, email: first.email }),
    ).rejects.toBeInstanceOf(DuplicateEmailError)
  })

  it("does not record an invite for someone who is gone", async () => {
    await expect(
      repository().recordInvite(crypto.randomUUID(), "2026-10-11T00:00:00Z"),
    ).rejects.toBeInstanceOf(PersonNotFoundError)
  })

  it("turns an invite into invite-expired once its time passes", async () => {
    let clock = now
    const created = createMockPeopleRepository(
      () => clock,
      async () => {},
    )
    const { id } = await created.create(newcomer)
    await created.recordInvite(id, new Date(now + 1000).toISOString())
    expect((await created.list()).find((p) => p.id === id)?.activation).toBe(
      "invited",
    )
    clock = now + 2000
    expect((await created.list()).find((p) => p.id === id)?.activation).toBe(
      "invite-expired",
    )
  })
})
