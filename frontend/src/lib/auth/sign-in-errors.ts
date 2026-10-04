// accept_invite raises each failure with one of these codes as its hint (migration 20261002000000).
const inviteMessages = {
  invite_not_found:
    "This invite link is no longer valid. Ask your company for a new one.",
  invite_already_accepted: "This invite has already been used.",
  invite_expired: "This invite has expired. Ask your company to send it again.",
  invite_email_unconfirmed:
    "Your email is not confirmed yet. Sign in again with the code we send you.",
  invite_person_removed: "Your company has removed this invite.",
  invite_person_linked:
    "This invite belongs to someone who has already joined.",
  invite_wrong_email:
    "This invite was sent to another email. Sign in with that address.",
  invite_failed: "We could not accept this invite. Try the link again.",
  invite_already_member:
    "You already belong to a company, and an account can belong to only one.",
} as const

const messages = {
  ...inviteMessages,
  company_failed: "We could not create your company. Try again.",
  no_company:
    "This email belongs to no company on Cadence. Create your company, or open the invite your company emailed you.",
  lookup_failed:
    "We could not check your account just now. Try again in a moment.",
  link_expired: "That sign-in link has expired. Ask for a new code.",
  sign_in_failed: "We could not sign you in. Try again.",
  send_failed: "We could not send the code. Try again.",
  too_many_attempts: "Too many attempts. Wait a minute and try again.",
} as const

export type InviteFailure = keyof typeof inviteMessages
export type SignInError = keyof typeof messages

// What an accept_invite error means for the viewer.
export function inviteFailure(hint: string | null | undefined): InviteFailure {
  return hint && Object.hasOwn(inviteMessages, hint)
    ? (hint as InviteFailure)
    : "invite_failed"
}

// The `error` query param is user-controlled: only known codes pick a message.
export function signInErrorMessage(code: string | null | undefined) {
  if (!code) return null
  return Object.hasOwn(messages, code)
    ? messages[code as SignInError]
    : messages.sign_in_failed
}
