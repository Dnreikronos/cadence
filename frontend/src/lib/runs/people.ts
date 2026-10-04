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

// A run keeps the ids of the people it paid. Names come from the people list, which may
// have lost one since (removal is final). Until the list has answered there is no name
// to show, and `undefined` lets the screen show a placeholder instead of a wrong one.
export function nameLookup(
  people: readonly { id: string; name: string }[] | undefined,
  answered: boolean,
) {
  const names = new Map(people?.map((person) => [person.id, person.name]))
  return (personId: string) =>
    answered ? (names.get(personId) ?? unknownPerson) : undefined
}
