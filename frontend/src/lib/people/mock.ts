import type { Activation, Person, PersonInput } from "./types"

// Stand-in for Supabase (people) and the proof service (amounts, invites) until
// #79 lands the typed client. It keeps the same split: nothing here pretends the
// amount belongs next to the person row.
let people: Person[] = [
  {
    id: "p1",
    name: "Bruno Costa",
    email: "bruno@solaris.example",
    kind: "employee",
    activation: "active",
    monthlyAmount: 4200,
  },
  {
    id: "p2",
    name: "Mariana Souza",
    email: "mariana@solaris.example",
    kind: "employee",
    activation: "invited",
    monthlyAmount: 3800,
  },
  {
    id: "p3",
    name: "Diego Martins",
    email: "diego@martins.example",
    kind: "contractor",
    activation: "not-invited",
    monthlyAmount: 6300,
  },
  {
    id: "p4",
    name: "Northwind Audit",
    email: "billing@northwind.example",
    kind: "supplier",
    activation: "invite-expired",
    monthlyAmount: 9500,
  },
]

const delay = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))

function assertUniqueEmail(email: string, exceptId?: string) {
  const taken = people.some(
    (person) =>
      person.id !== exceptId &&
      person.email.toLowerCase() === email.toLowerCase(),
  )
  if (taken) throw new Error("Someone with this email is already on your list")
}

export async function listPeople(): Promise<Person[]> {
  await delay()
  return structuredClone(people)
}

export async function createPerson(input: PersonInput): Promise<Person> {
  await delay()
  assertUniqueEmail(input.email)
  const person: Person = {
    ...input,
    id: crypto.randomUUID(),
    activation: "not-invited",
  }
  people = [...people, person]
  return structuredClone(person)
}

export async function updatePerson(
  id: string,
  input: PersonInput,
): Promise<Person> {
  await delay()
  assertUniqueEmail(input.email, id)
  const current = people.find((person) => person.id === id)
  if (!current) throw new Error("This person no longer exists")
  // A changed email invalidates the invite that went to the old address.
  const emailChanged = current.email.toLowerCase() !== input.email.toLowerCase()
  const activation: Activation =
    emailChanged && current.activation !== "active"
      ? "not-invited"
      : current.activation
  const next = { ...current, ...input, activation }
  people = people.map((person) => (person.id === id ? next : person))
  return structuredClone(next)
}

// Removal is final (the database trigger allows no way back).
export async function removePerson(id: string): Promise<void> {
  await delay()
  people = people.filter((person) => person.id !== id)
}

export async function sendInvite(id: string): Promise<Person> {
  await delay(400)
  const current = people.find((person) => person.id === id)
  if (!current) throw new Error("This person no longer exists")
  if (current.activation === "active") {
    throw new Error("This person already has an account")
  }
  const next: Person = { ...current, activation: "invited" }
  people = people.map((person) => (person.id === id ? next : person))
  return structuredClone(next)
}
