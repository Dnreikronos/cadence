"use client"

import { useAuditors } from "@/lib/auditors/queries"
import { ActivationPill } from "@/app/company/people/activation-pill"

const rowColumns =
  "md:grid-cols-[minmax(0,1.6fr)_128px_128px_48px] md:items-center md:gap-x-4"

export function AuditorsScreen() {
  const auditors = useAuditors()

  if (auditors.isPending) return <p>Loading...</p>
  if (auditors.isError) return <p>Error</p>

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div
        className={`hidden border-b border-line bg-surface-subtle px-4 py-2 text-label text-ink-muted uppercase md:grid ${rowColumns}`}
      >
        <span>Email</span>
        <span>Status</span>
        <span>Invited</span>
        <span className="sr-only">Actions</span>
      </div>

      <ul>
        {auditors.data.map((auditor) => (
          <li
            key={auditor.id}
            className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-0 md:grid ${rowColumns}`}
          >
            <span className="text-ui text-ink">{auditor.email}</span>
            <span>
              <ActivationPill activation={auditor.status} />
            </span>
            <span className="text-ui text-ink-muted">
              {formatDate(auditor.invitedAt)}
            </span>
            <span />
          </li>
        ))}
      </ul>
    </div>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}
