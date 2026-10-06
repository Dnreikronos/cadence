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

// A run pays token accounts and carries no person, so who a payment pays is found by the
// account, among the people as they are now: someone removed since, or whose account
// changed, is not found.
export function peopleByAccount<T extends { tokenAccount: string | null }>(
  people: readonly T[] | undefined,
) {
  const byAccount = new Map(
    people?.flatMap((person) =>
      person.tokenAccount ? [[person.tokenAccount, person] as const] : [],
    ),
  )
  return (destination: string) => byAccount.get(destination)
}
