import type { AuditorStatus } from "@/lib/api/schemas"

// What removing a row means depends on what the row is: an active auditor has
// access to withdraw, an invite is only a pending offer. The copy says no more
// than the service does: it revokes or withdraws, with no promise about timing.
export type RemovalCopy = {
  description: string
  keep: string
  confirm: string
  pending: string
  done: string
  // Names the row it is for: "<action> <email>".
  action: string
}

// A row whose status the app does not know is its own kind: it may have access, so the
// copy neither says "invite" nor promises that access ends at once.
export type RemovalKind = AuditorStatus | "unrecognized"

export function removalKind(row: {
  status: AuditorStatus
  unrecognized?: boolean
}): RemovalKind {
  return row.unrecognized ? "unrecognized" : row.status
}

export function removalCopy(kind: RemovalKind): RemovalCopy {
  switch (kind) {
    case "unrecognized":
      return {
        description:
          "If they have access, it ends when the service processes the removal.",
        keep: "Keep",
        confirm: "Remove auditor",
        pending: "Removing…",
        done: "Removal requested for",
        action: "Remove auditor",
      }
    case "active":
      return {
        description:
          "This removes their access to your payments. Amounts they have already viewed or exported stay with them. To give access back, send a new invite.",
        keep: "Keep access",
        confirm: "Revoke access",
        pending: "Revoking…",
        done: "Access revoked for",
        action: "Revoke access for",
      }
    case "invite-expired":
      return {
        description:
          "The invite has expired and can't be accepted any more. You can invite them again at any time.",
        keep: "Keep",
        confirm: "Remove invite",
        pending: "Removing…",
        done: "Expired invite removed for",
        action: "Remove expired invite for",
      }
    case "invited":
      return {
        description:
          "They haven't accepted yet, and cancelling withdraws the invite. You can send a new one later.",
        keep: "Keep invite",
        confirm: "Cancel invite",
        pending: "Cancelling…",
        done: "Invite cancelled for",
        action: "Cancel invite for",
      }
  }
}
