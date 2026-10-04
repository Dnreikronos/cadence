export type SignedInView = "continue" | "already_member"

// What /sign-in does for someone who is already signed in with a company: send them on, or,
// when they came through an invite, say why it cannot be used.
export function signedInView({
  invite,
  error,
  demo,
}: {
  invite: string | null
  error: string | null
  demo: boolean
}): SignedInView {
  // The demo viewer has no invites: it keeps going straight to its area.
  if (demo) return "continue"
  // A link that has just been spent, by a person who is signed in now: a double click on
  // Continue, where one request joined them and the other found the token used. They are in.
  if (error === "link_expired") return "continue"
  if (invite || error === "invite_already_member") return "already_member"
  return "continue"
}
