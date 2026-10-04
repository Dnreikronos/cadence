"use client"

import { useAuditors } from "@/lib/auditors/queries"

export function AuditorsScreen() {
  const auditors = useAuditors()

  if (auditors.isPending) return <p>Loading...</p>
  if (auditors.isError) return <p>Error</p>

  return (
    <ul>
      {auditors.data.map((auditor) => (
        <li key={auditor.id}>
          {auditor.email} - {auditor.status}
        </li>
      ))}
    </ul>
  )
}
