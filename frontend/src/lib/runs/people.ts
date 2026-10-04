// "Bruno Costa" -> "BC". Display only.
export function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

export const unknownPerson = "Someone no longer on your list"

// A run keeps the ids of the people it paid. Names come from the people list, which
// may have lost one since (removal is final) or not have loaded.
export function nameLookup(people?: readonly { id: string; name: string }[]) {
  const names = new Map(people?.map((person) => [person.id, person.name]))
  return (personId: string) => names.get(personId) ?? unknownPerson
}
