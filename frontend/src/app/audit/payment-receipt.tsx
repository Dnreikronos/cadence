"use client"

import { useState } from "react"
import { ExternalLink } from "lucide-react"
import { AmountDisplay } from "@/components/ui/amount-display"
import { ButtonCopy } from "@/components/ui/button-copy"
import { buttonVariants } from "@/components/ui/button"
import { Modal } from "@/components/ui/modal"
import { StatusPill } from "@/components/ui/status-pill"
import { TransparentBadge } from "@/components/ui/transparent-badge"
import { WhoCanSee } from "@/components/ui/who-can-see"
import type { AuditRow } from "@/lib/audit/payments"
import { explorerTxUrl } from "@/lib/receipts/receipt"
import { cluster } from "@/lib/solana/cluster"
import { Time, timeFormat } from "./list-parts"

// Kept inline and small: the shared receipt (components/app/receipt-dialog.tsx, task D)
// replaces it once on main, with the auditor role's "Paid by" and "Paid to" labels.
export function PaymentReceipt({
  row,
  company,
  onClose,
}: {
  row: AuditRow | null
  company: string
  onClose: () => void
}) {
  // The dialog fades out after `row` is gone: it keeps showing the last one until it has.
  const [last, setLast] = useState(row)
  if (row && row !== last) setLast(row)
  const shown = row ?? last
  // Null for a signature that is not base58: no link is built from it.
  const explorer = shown && explorerTxUrl(shown.signature, cluster.name)

  return (
    <Modal
      open={row !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Payment receipt"
      description="As the auditor you read the amount; the public sees ciphertext unless the payment is marked transparent."
    >
      {shown && (
        <div className="space-y-4">
          <dl className="space-y-3 text-ui">
            <Detail label="Paid by">{company}</Detail>
            <Detail label="Paid to">{shown.name}</Detail>
            <Detail label="Amount">
              <span className="inline-flex items-center gap-1.5">
                <AmountDisplay amount={shown.usd} />
                <WhoCanSee viewerRole="auditor" hasAuditor />
              </span>
            </Detail>
            <Detail label="Status">
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <StatusPill status={shown.status} />
                {shown.transparent && <TransparentBadge />}
              </span>
            </Detail>
            <Detail label="Date">
              <Time iso={shown.paidAt} format={timeFormat} />
            </Detail>
            <Detail label="Signature">
              {shown.signature ? (
                <span className="flex items-start gap-2">
                  <span className="min-w-0 font-mono text-caption break-all">
                    {shown.signature}
                  </span>
                  <ButtonCopy
                    value={shown.signature}
                    label="Copy signature"
                    toastTitle="Signature copied"
                  />
                </span>
              ) : (
                <span className="text-ink-muted">Not on-chain yet</span>
              )}
            </Detail>
          </dl>
          <div className="flex justify-end gap-2">
            {explorer && (
              <a
                href={explorer}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "secondary" })}
              >
                View on explorer
                <ExternalLink className="size-3.5" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className={buttonVariants()}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Detail({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[96px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 wrap-break-word text-ink">{children}</dd>
    </div>
  )
}
