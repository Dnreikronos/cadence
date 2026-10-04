import type { Activation } from "./types"

export type PersonStatus = "pending" | "active" | "removed"

// `inviteExpiresAt` is the expiry of the person's pending invite, or null when
// there is none. A removed person is never listed, so it has no activation.
export function deriveActivation(
  status: Exclude<PersonStatus, "removed">,
  inviteExpiresAt: string | null,
  now = Date.now(),
): Activation {
  if (status === "active") return "active"
  if (inviteExpiresAt === null) return "not-invited"
  // An unreadable expiry fails the comparison, so it never claims a live invite.
  return Date.parse(inviteExpiresAt) > now ? "invited" : "invite-expired"
}
