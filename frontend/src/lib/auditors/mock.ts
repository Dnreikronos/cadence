import type { Auditor } from "./types"

let auditors: Auditor[] = [
  {
    id: "a1",
    email: "joao@accounting.example",
    status: "invited",
    invitedAt: "2026-10-03",
  },
  {
    id: "a2",
    email: "bruna@accounting.example",
    status: "active",
    invitedAt: "2026-10-01",
  },
  {
    id: "a3",
    email: "eduardo@accounting.example",
    status: "invite-expired",
    invitedAt: "2026-09-20",
  },
]

const delay = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))

export async function listAuditors(): Promise<Auditor[]> {
  await delay()
  return structuredClone(auditors)
}

function assertUniqueEmail(email: string) {
  const taken = auditors.some(
    (auditor) => auditor.email.toLowerCase() === email.toLowerCase(),
  )
  if (taken)
    throw new Error("This email is already an auditor or has a pending invite")
}

export async function inviteAuditor(email: string): Promise<Auditor> {
  await delay()
  assertUniqueEmail(email)
  const auditor: Auditor = {
    email,
    id: crypto.randomUUID(),
    status: "invited",
    invitedAt: new Date().toISOString(),
  }
  auditors = [...auditors, auditor]
  return structuredClone(auditor)
}

export async function removeAuditor(id: string): Promise<void> {
  await delay()
  auditors = auditors.filter((auditor) => auditor.id !== id)
}
