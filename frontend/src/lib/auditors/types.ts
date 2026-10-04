export type AuditorStatus = "active" | "invited" | "invite-expired"

export type Auditor = {
  id: string
  email: string
  status: AuditorStatus
  invitedAt: string
}
