import { AmountNotSavedError } from "./errors"
import type { PeopleRepository } from "./repository"
import type { PersonInput } from "./types"

export type SavePersonRequest = {
  // Absent when adding.
  id?: string
  input: PersonInput
  // Base units. Absent when the amount is left as it is.
  amount?: string
  // The address an unaccepted invite was sent to, if there is one. An edit that
  // moves the person elsewhere leaves that invite useless.
  invitedEmail?: string
}

export type SavePersonResult = {
  id: string
  inviteStale: boolean
}

export type PeopleDeps = {
  repository: PeopleRepository
  setAmount: (personId: string, amount: string) => Promise<unknown>
}

// The person goes to the table and the amount to the proof service: two stores,
// no transaction. The table goes first, so a failed amount leaves a person with
// no amount, which the list shows, rather than an amount nobody owns.
export async function savePerson(
  { repository, setAmount }: PeopleDeps,
  { id, input, amount, invitedEmail }: SavePersonRequest,
): Promise<SavePersonResult> {
  let personId: string
  if (id === undefined) {
    personId = (await repository.create(input)).id
  } else {
    await repository.update(id, input)
    personId = id
  }
  if (amount !== undefined) {
    try {
      await setAmount(personId, amount)
    } catch (error) {
      throw new AmountNotSavedError(error)
    }
  }
  return {
    id: personId,
    inviteStale:
      invitedEmail !== undefined &&
      invitedEmail.toLowerCase() !== input.email.toLowerCase(),
  }
}

export type InviteDeps = {
  repository: PeopleRepository
  invite: (personId: string) => Promise<{ expires_at: string }>
}

// The invite service sends the mail and writes the invite row. Only a send that
// succeeded is recorded, so a failed one never shows as "Invite sent".
export async function sendInvite(
  { repository, invite }: InviteDeps,
  personId: string,
) {
  const sent = await invite(personId)
  await repository.recordInvite(personId, sent.expires_at)
  return sent
}
