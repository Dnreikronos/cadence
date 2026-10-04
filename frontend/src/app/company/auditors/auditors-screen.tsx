"use client"

import { useAuditors } from "@/lib/auditors/queries"
import { ActivationPill } from "@/app/company/people/activation-pill"

export function AuditorsScreen() {
  const auditors = useAuditors()

  if (auditors.isPending) return <p>Loading...</p>
  if (auditors.isError) return <p>Error</p>

  return (
    <ul>
      {auditors.data.map((auditor) => (
        <li key={auditor.id}>
          {auditor.email} - <ActivationPill activation={auditor.status} /> -
          {formatDate(auditor.invitedAt)}
        </li>
      ))}
    </ul>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}
